const fs = require('fs');
const { JSDOM } = require('jsdom');

function processFile(filename, viewIdToKeep, keepRouteCard, keepPip, keepDashboard) {
    const html = fs.readFileSync(filename, 'utf8');
    const dom = new JSDOM(html);
    const document = dom.window.document;

    ['view-home', 'view-simulation', 'view-live'].forEach(id => {
        if (id !== viewIdToKeep) {
            const el = document.getElementById(id);
            if (el) el.remove();
        } else {
            const el = document.getElementById(id);
            if (el) el.removeAttribute('hidden');
        }
    });

    if (!keepRouteCard) {
        const rc = document.getElementById('routeCardContainer');
        if (rc) rc.remove();
    }
    
    if (!keepPip) {
        const pip = document.getElementById('pip-template');
        if (pip) pip.remove();
    }

    if (!keepDashboard) {
        const db = document.getElementById('rideDashboard');
        if (db) db.remove();
    }

    fs.writeFileSync(filename, dom.serialize());
}

processFile('simulation.html', 'view-simulation', true, true, false);
processFile('live.html', 'view-live', true, false, true);

console.log('Processed simulation.html and live.html');