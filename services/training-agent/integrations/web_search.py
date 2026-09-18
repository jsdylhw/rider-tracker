"""Tavily web search transport. Credentials never enter tool results."""
import json
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from integrations.provider_error import ProviderError
from settings import load_config


class TavilySearchClient:
    def search(self, query):
        config = load_config()
        settings = config.get('tavily') or config.get('Tavily') or {}
        key = settings.get('api_key')
        if not key:
            raise ProviderError('请配置 tavily.api_key', provider='tavily', stage='web_search', code='provider_not_configured')
        request = Request('https://api.tavily.com/search', data=json.dumps({
            'query': query, 'max_results': 5, 'search_depth': 'advanced',
            'include_answer': False, 'include_raw_content': 'text',
        }).encode(), headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'})
        try:
            with urlopen(request, timeout=30) as response:
                result = json.load(response)
        except HTTPError as exc:
            raise ProviderError(f'Tavily HTTP {exc.code}', provider='tavily', stage='web_search', retryable=exc.code == 429 or exc.code >= 500) from None
        except (URLError, OSError, ValueError) as exc:
            raise ProviderError(f'Tavily 搜索不可用：{type(exc).__name__}', provider='tavily', stage='web_search', retryable=True) from None
        if not isinstance(result, dict) or not isinstance(result.get('results'), list):
            raise ProviderError('Tavily 响应格式无效', provider='tavily', stage='web_search', code='provider_invalid_response')
        return result['results']
