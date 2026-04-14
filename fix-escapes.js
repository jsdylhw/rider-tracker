const fs = require('fs');
const dir = 'c:/codes/rider_tracker/src/ui/renderers';

fs.readdirSync(dir).forEach(f => {
    if (f.endsWith('.js')) {
        const p = dir + '/' + f;
        let c = fs.readFileSync(p, 'utf8');
        
        // Remove backslash before backtick
        c = c.replace(/\\`/g, '`');
        
        // Remove backslash before dollar sign
        c = c.replace(/\\\$/g, '$');
        
        fs.writeFileSync(p, c);
        console.log('Fixed', f);
    }
});