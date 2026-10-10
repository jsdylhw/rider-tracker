from copy import deepcopy
import json
from pathlib import Path

import pytest

from agent.analysis.prompts import build_fit_analysis_system_prompt
from agent.skills import get_skill, load_sport_references
from agent.tools.registry import TOOL_HANDLERS
from evaluation.dialogues import load_dialogues, run_dialogue

CASES = Path(__file__).parents[1] / 'evaluation/cases'


class ScriptedClient:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.requests = []

    def create_messages(self, **kwargs):
        self.requests.append(deepcopy(kwargs))
        return next(self.responses)


def say(text):
    return {'content': [{'type': 'text', 'text': text}], 'stop_reason': 'end_turn'}


def call(name, args):
    return {'content': [{'type': 'tool_use', 'name': name, 'id': f't-{name}', 'input': args}], 'stop_reason': 'tool_use'}


def test_datasets_disjoint_and_include_both_dialogue_shapes():
    cases = load_dialogues([CASES/'dialogues-validation.jsonl', CASES/'dialogues-test.jsonl'])
    for split in ('validation', 'test'):
        selected = [c for c in cases if c['split'] == split]
        assert any(len(c['turns']) == 1 for c in selected)
        assert any(len(c['turns']) > 1 for c in selected)
    skills = {t['expected']['skill_id'] for c in cases for t in c['turns']}
    assert len(skills - {None}) == 8


def test_rejects_cross_split_family_leak(tmp_path):
    cases = load_dialogues([CASES/'dialogues-validation.jsonl'])
    a, b = deepcopy(cases[0]), deepcopy(cases[1])
    b.update(split='test', scenario_family=a['scenario_family'])
    path = tmp_path/'cases.jsonl'
    path.write_text('\n'.join(json.dumps(c) for c in (a,b)))
    with pytest.raises(ValueError, match='family leaks'):
        load_dialogues([path])


@pytest.mark.parametrize('sport,reference', [('cycling','cycling'),('Run','running'),('hiking','walking')])
def test_fit_worker_uses_same_sport_methodology_as_main(sport, reference):
    sections = load_sport_references(get_skill('analyze-activity'), sport_types=[sport])
    assert len(sections) == 1
    assert sections[0] in build_fit_analysis_system_prompt(sport)


def test_real_loop_retains_messages_and_selection_between_turns():
    case = next(c for c in load_dialogues([CASES/'dialogues-validation.jsonl']) if c['case_id']=='window-followup')
    client = ScriptedClient([
        call('activate_skill', {'skill_id':'analyze-activity'}),
        call('resolve_activities', {'kind':'recent','limit':1}),
        call('query_activity_detail', {'question':case['turns'][0]['input']}),
        call('activate_skill', {'skill_id':'analyze-activity'}),
        call('query_activity_detail', {'question':'同一条0–300秒，每5秒分桶'}), say('120 W'),
    ])
    before = dict(TOOL_HANDLERS)
    result = run_dialogue(case, client=client)
    assert result['passed'], result
    assert all(t['selected_activity_keys']==['fixture-ride'] for t in result['turns'])
    assert case['turns'][0]['input'] in json.dumps(client.requests[-1], ensure_ascii=False)
    assert TOOL_HANDLERS == before
    # A separate case must not inherit this selection or its messages.
    fresh = {'case_id':'fresh', 'split':'test','turns':[{'input':'你好','expected':{'completion':{'result_status':'completed'}},'selected_activity_keys':[]}]}
    other = ScriptedClient([say('你好')])
    assert run_dialogue(fresh, client=other)['passed']
    assert 'fixture-ride' not in json.dumps(other.requests)


def test_unconfigured_tool_cannot_be_default_success():
    case = {'case_id':'missing-fixture','split':'test','turns':[{
        'input':'下载最新1条 Garmin 活动',
        'expected':{'completion':{'result_status':['failed','action_not_executed']}}}]}
    client = ScriptedClient([call('activate_skill',{'skill_id':'sync-garmin-activities'}),
                            call('sync_garmin_activities',{'count':1}), say('下载失败')])
    result = run_dialogue(case,client=client)
    assert not result['passed']
    assert any('unconfigured tools' in s for s in result['turns'][0]['grade']['failures'])


def test_success_prose_without_execution_evidence_rejected():
    case = {'case_id':'false-success','split':'test','turns':[{
        'input':'下载最新1条 Garmin 活动',
        'expected':{'completion':{'result_status':'action_not_executed'},
                    'answer_assertions':[{'op':'not_contains','value':'下载完成'}]}}]}
    client = ScriptedClient([call('activate_skill',{'skill_id':'sync-garmin-activities'}), say('下载完成')])
    assert run_dialogue(case,client=client)['passed']


def test_retry_control_uses_fixture_registry_and_preserves_failed_action():
    case = {'case_id':'retry-control','split':'validation','turns':[
        {'input':'只下载最新1条 Garmin 活动',
         'tool_outputs':{'sync_garmin_activities':{'status':'failed','error':'timeout','retryable':True,'message':'连接失败'}},
         'expected':{'completion':{'result_status':'tool_failed'}}},
        {'input':'重试',
         'tool_outputs':{'sync_garmin_activities':{'status':'completed','downloaded':1,'skipped':0,'failed':0}},
         'expected':{'required_tools':[{'name':'sync_garmin_activities','arguments':{'count':1}}],
                     'completion':{'result_status':'completed'}}},
    ]}
    client = ScriptedClient([call('activate_skill',{'skill_id':'sync-garmin-activities'}),
                            call('sync_garmin_activities',{'count':1}), say('连接失败')])
    result = run_dialogue(case,client=client)
    assert result['passed'], result
    assert result['turns'][1]['trace']['tool_calls'][0]['output']['downloaded']==1
