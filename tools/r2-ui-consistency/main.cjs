const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const root = path.resolve(process.argv[process.argv.indexOf('--root') + 1]);
const allowed = path.resolve(__dirname, '../../.review/WBT-DIRECTOR-REBASELINE-20260912/evidence');
if (!root.startsWith(allowed + path.sep)) throw new Error('Evidence root outside packet');
app.setPath('userData', path.join(root, 'electron-user-data'));
const mode = process.argv.includes('--offscreen') ? 'offscreen-explicit-fallback' : 'hidden';
const log = { mode, startedAt: new Date().toISOString(), subjectLedgerSha256: createHash('sha256').update(fs.readFileSync(path.join(root,'subject-hashes.json'))).digest('hex'), paintWhenInitiallyHidden: 'default true', backgroundThrottling: false, fallback: mode === 'hidden' ? 'none' : 'explicit offscreen retry after hidden matrix timeout; no silent fallback', errors: [] };
const matrix = [];
let win;
const timeout = setTimeout(() => finish(1, { error: '120-second bounded timeout' }), 120000);
function finish(code, result) {
    clearTimeout(timeout);
    fs.writeFileSync(path.join(root, `smoke-${mode}.json`), JSON.stringify({ ...log, electron: process.versions.electron, time: new Date().toISOString(), exitCode: code, ...result }, null, 2));
    if (code !== 0) fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ ...log, status:'FAIL', exitCode:code, matrix, ...result },null,2));
    win?.destroy(); app.exit(code);
}
app.whenReady().then(async () => {
    try {
        win = new BrowserWindow({ show: false, width: 800, height: 550, webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, offscreen: mode !== 'hidden' } });
        win.setContentSize(824, 574);
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.webContents.on('will-navigate', event => event.preventDefault());
        win.webContents.session.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
        win.webContents.on('console-message', (_event, _level, message) => { log.errors.push(String(message)); });
        await win.loadFile(path.join(root, 'index.html'));
        // A prior matrix run may persist this file-origin's zoom in isolated userData.
        win.webContents.setZoomFactor(1);
        win.setContentSize(824, 574);
        const result = await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const end=Date.now()+10000;function probe(){if(window.r2) window.r2.smoke().then(resolve,reject);else if(Date.now()>end) reject(new Error('fixture not ready'));else setTimeout(probe,50)}probe()})`);
        const capture = await win.webContents.capturePage();
        if (capture.isEmpty()) throw new Error('Empty capture; explicit fallback required');
        fs.writeFileSync(path.join(root, `smoke-${mode}.png`), capture.toPNG());
        // Native Chromium keyboard delivery, not only DOM .click().
        await win.webContents.executeJavaScript("document.querySelector('.command-navigation-rail-copy').focus()");
        win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});
        win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
        const keyboard = await win.webContents.executeJavaScript("new Promise(resolve=>requestAnimationFrame(()=>resolve({tag:document.activeElement.tagName,focusVisible:document.activeElement.matches(':focus-visible')})))");
        for (const zoom of [1, 1.5, 2]) {
            win.webContents.setZoomFactor(zoom);
            for (const [width,height] of [[800,550],[400,300],[240,180]]) {
                for (const [count,orientation] of [[1,'horizontal'],[2,'horizontal'],[2,'vertical']]) {
                    fs.writeFileSync(path.join(root, 'progress.json'), JSON.stringify({zoom,width,height,count,orientation}));
                    win.setContentSize(Math.ceil((width * (orientation==='horizontal'?count:1)+24)*zoom), Math.ceil((height*(orientation==='vertical'?count:1)+24)*zoom));
                    const measured = await win.webContents.executeJavaScript(`window.r2.measure(${width},${height},${count},${JSON.stringify(orientation)})`);
                    matrix.push({ zoom, ...measured });
                    await win.webContents.executeJavaScript('window.r2.searchCheck()');
                    const shot = await win.webContents.capturePage();
                    fs.mkdirSync(path.join(root, 'screenshots'), { recursive:true });
                    fs.writeFileSync(path.join(root, 'screenshots', [zoom,width,height,count,orientation].join('-')+'.png'), shot.toPNG());
                    await win.webContents.executeJavaScript('window.r2.closeSearch()');
                }
            }
        }
        await win.webContents.executeJavaScript('window.r2.offscreenChecks()');
        await win.webContents.executeJavaScript('window.r2.clearChecks()');
        const assertions = await win.webContents.executeJavaScript('window.r2.results');
        fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ ...log, status:'PASS', exitCode:0, time:new Date().toISOString(), matrix, keyboard, assertions, executed:assertions.length, skipped:0, coverage:'controlled production composition, not full application runtime' },null,2));
        finish(0, { ...result, status:'PASS', executed:assertions.length, skipped:0 });
    } catch (error) {
        const assertions = await win?.webContents.executeJavaScript('window.r2?.results || []').catch(() => []);
        const capture = await win?.webContents.capturePage().catch(() => null);
        if (capture && !capture.isEmpty()) fs.writeFileSync(path.join(root, 'failure.png'), capture.toPNG());
        finish(1, { error: String(error.stack || error), assertions });
    }
});
