import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { TermWrap } from '../../frontend/app/view/term/termwrap';
import { VisualAnchorRegistry } from '../../frontend/app/view/term/visual-anchor';
import { TerminalContentFrame } from '../../frontend/app/view/term/command-navigation-rail';
import { useSearch } from '../../frontend/app/element/search';
import { getDefaultStore } from 'jotai';
import { calls, setRecords, setFailClear, clipboardWrites } from './adapters';
import '../../frontend/app/view/term/xterm.css';
import '../../frontend/app/view/term/term.scss';
import '../../frontend/app/theme.scss';

Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { clipboardWrites.push(value); } } });
const results: any[] = [];
const assert = (name: string, condition: boolean, detail?: unknown) => {
    results.push({ name, pass: !!condition, detail });
    if (!condition) throw new Error(name + ': ' + JSON.stringify(detail ?? ''));
};
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function settled() { await document.fonts.ready; await frame(); await frame(); await frame(); }
async function until(check: () => boolean, label: string, timeout = 3500) {
    const end = performance.now() + timeout;
    while (!check() && performance.now() < end) await frame();
    assert(label, check());
}
const owners = new Map<string, any>();
function Pane({ id }: { id: string }) {
    const ref = React.useRef<HTMLDivElement>(null);
    const [wrap, setWrap] = React.useState<TermWrap | null>(null);
    const searchProps = useSearch({ anchorRef: ref });
    const model = React.useMemo(() => ({ blockId: id, termRef: { current: wrap } }), [id, wrap]);
    React.useEffect(() => {
        const terminal = new Terminal({ allowProposedApi: true, rows: 12, cols: 50, scrollback: 1000 });
        const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(ref.current!);
        const value: any = Object.create(TermWrap.prototype);
        Object.assign(value, { terminal, blockId: id, visualAnchorRegistry: new VisualAnchorRegistry(), visualAnchorCues: new Map(), commandAnchorSubscribers: new Set(), selectedCommandAnchor: null, ingressGeneration: 0, heldData: [], ingressState: 'live', loaded: true });
        value.searchProps = searchProps;
        owners.set(id, value); setWrap(value);
        const resize = new ResizeObserver(() => fit.fit());
        resize.observe(ref.current!);
        return () => { resize.disconnect(); owners.delete(id); terminal.dispose(); };
    }, [id]);
    return <TerminalContentFrame blockId={id} termWrap={wrap} model={model} connectElemRef={ref} searchProps={searchProps} stickerConfig={{charWidth:8,charHeight:16,rows:24,cols:80,blockId:'d1eaddcb-fixture'}} />;
}
const root = createRoot(document.getElementById('root')!);
function render(width: number, height: number, count = 1, orientation = 'horizontal') {
    // Fixture supplies only independent pane bounds; all measured inner JSX is production.
    root.render(<div style={{ display: 'flex', flexDirection: orientation === 'horizontal' ? 'row' : 'column' }}>
        {Array.from({ length: count }, (_, i) => <div key={i} data-pane={i} style={{ width, height, flex: 'none' }}><Pane id={'pane-' + i} /></div>)}
    </div>);
}
function record(id: string, block: string, mode = 'structured') {
    return { id, wave_block_id: block, session_epoch: 'test', start_hook_sequence: 1, finish_hook_sequence: 2,
        command: 'same command', cwd: '/', state: 'finished', completion_reason: 'normal', visibility_generation: 1,
        output_total_bytes: ('output:' + id).length, output_stored_bytes: ('output:' + id).length,
        output_truncated: false, output_completeness: 'complete', execution_mode: mode,
        output_source: 'hostStructured', runtime_host_id: 'host', runtime_runspace_id: 'runspace',
        capture_contract_version: 1, protocol_version: 1, output_attribution: 'exclusive',
        output_text_safety: 'plain_text', output_state: 'closed', started_at_unix_ms: 1,
        finished_at_unix_ms: 2, success: true, exit_code: 0 };
}
async function anchor(value: any, id: string, seq: number, mode = 'structured', reverse = false) {
    const context = { blockId: value.blockId, sessionEpoch: 'test', hookSequence: seq, commandId: id, anchorNonce: 'nonce-' + id, hostId: 'host', runspaceId: 'runspace', mode };
    if (reverse) value.confirmVisualAnchor(context);
    value.registerVisualAnchor({ nonce: 'nonce-' + id, epoch: 'test', id, phase: 'start', seq, hostid: 'host', runspaceid: 'runspace' });
    if (!reverse) value.confirmVisualAnchor(context);
    await new Promise<void>(resolve => value.terminal.write(id + '\r\nfixture output\r\n', resolve));
}
const pane = () => document.querySelector('[data-pane="0"]')!;
const query = (selector: string) => pane().querySelector<HTMLElement>(selector)!;
const selected = () => query('.command-navigation-rail').dataset.selectedCommandId;
function rect(element: Element) { return element.getBoundingClientRect().toJSON(); }
function overlap(a: any, b: any) { return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom; }
function geometry() {
    return [...document.querySelectorAll('[data-pane]')].map((p, index) => {
        const content = p.querySelector('.term-content-frame')!;
        const clear = p.querySelector('.terminal-clear-action-button')!;
        const nav = p.querySelector('.command-navigation-rail-controls')!;
        const copy = p.querySelector('.command-navigation-rail-copy')!;
        const grid = p.querySelector('.xterm-screen')!;
        const c = rect(content), a = rect(clear), n = rect(nav), b = rect(copy), g = rect(grid);
        assert('pane ' + index + ' controls in bounds', [a,n,b].every(r => r.left >= c.left && r.right <= c.right + .1 && r.top >= c.top && r.bottom <= c.bottom + .1), { c,a,n,b });
        assert('pane ' + index + ' top-right Clear', c.right - a.right <= 12 && a.top - c.top <= 12, {c,a});
        assert('pane ' + index + ' bottom-right Copy', c.right - b.right <= 12 && c.bottom - b.bottom <= 12);
        assert('pane ' + index + ' navigation vertically centered', Math.abs((n.top+n.bottom-c.top-c.bottom)/2) <= 2);
        assert('pane ' + index + ' no control overlap', !overlap(a,n) && !overlap(n,b) && !overlap(a,b));
        assert('pane ' + index + ' controls do not cover glyph rectangle', [a,n,b].every(r => !overlap(r,g)), {g,a,n,b});
        assert('pane ' + index + ' Clear hit test', clear.contains(document.elementFromPoint(a.left+a.width/2,a.top+a.height/2)), {viewport:[innerWidth,innerHeight],target:document.elementFromPoint(a.left+a.width/2,a.top+a.height/2)?.className});
        return { content:c, clear:a, navigation:n, copy:b, glyph:g, markers:[...p.querySelectorAll('.command-region-cue')].map(rect) };
    });
}
(window as any).r2 = {
    results,
    async smoke() {
        render(800,550);
        await until(() => owners.has('pane-0') && !!document.querySelector('.command-navigation-rail-copy'), 'real production composition mounted');
        await settled();
        assert('empty Copy All remains disabled', (query('.command-navigation-rail-copy') as HTMLButtonElement).disabled);
        const value = owners.get('pane-0');
        setRecords([record('a','pane-0'), record('b','pane-0')]);
        await anchor(value,'a',1); await anchor(value,'b',2,'structured',true);
        await until(() => selected() === 'b', 'initial latest selection');
        await until(() => !!query('.command-region-cue.is-selected'), 'selected marker rendered');
        assert('selected marker matches shared selection', query('.command-region-cue.is-selected').dataset.commandId === 'b');
        assert('every confirmed ordinary command has a marker', pane().querySelectorAll('.command-region-cue').length === 2);
        const inactiveWidth = getComputedStyle(query('.command-region-cue[data-command-id="a"]'), '::before').width;
        const activeWidth = getComputedStyle(query('.command-region-cue.is-selected'), '::before').width;
        assert('selected marker has a stronger shape not only color', parseFloat(activeWidth) > parseFloat(inactiveWidth), {inactiveWidth,activeWidth});
        query('.command-navigation-rail-controls button').click();
        await until(() => selected() === 'a', 'Previous selects exact earlier id');
        assert('first Previous disabled', (query('.command-navigation-rail-controls button') as HTMLButtonElement).disabled);
        query('.command-navigation-rail-copy').click(); await settled();
        assert('Copy All uses selected authoritative output only', clipboardWrites.at(-1) === 'same command\noutput:a', clipboardWrites);
        query('.command-region-cue[data-command-id="b"]').dispatchEvent(new MouseEvent('mouseover', { bubbles:true }));
        value.terminal.scrollToTop(); await settled();
        assert('hover and scroll preserve selection', selected() === 'a');
        await anchor(value,'interactive',3,'interactive');
        assert('interactive confirmation excluded', !value.getCommandAnchorSnapshot().some((a:any)=>a.commandId==='interactive'));
        await anchor(value,'unknown',4,'unknown');
        assert('unknown confirmation excluded', !value.getCommandAnchorSnapshot().some((a:any)=>a.commandId==='unknown'));
        await until(() => !pane().querySelector('.command-navigation-rail-message'), 'Copy feedback expires', 4000);
        return { phase:'SMOKE_AND_INTERACTION', results:[...results], geometry:geometry(), productionComposition:'TerminalContentFrame actual production JSX' };
    },
    async clearChecks() {
        const before = selected();
        setFailClear(true); query('.terminal-clear-action-button').click(); await settled();
        assert('failed Clear preserves selection', selected() === before);
        setFailClear(false); query('.terminal-clear-action-button').click(); await settled();
        await until(() => selected() === '', 'successful Clear resets selection');
        assert('empty state Copy disabled after Clear', (query('.command-navigation-rail-copy') as HTMLButtonElement).disabled);
        await until(() => query('.terminal-clear-action-status').textContent === '', 'Clear success feedback expires', 4000);
        return { results:[...results] };
    },
    async offscreenChecks() {
        const value = owners.get('pane-0');
        const before = selected();
        await new Promise<void>(resolve => value.terminal.write('scroll fixture\r\n'.repeat(100), resolve));
        value.terminal.scrollToBottom(); await settled();
        assert('offscreen scrolling does not retarget Copy All', selected() === before);
        const old = pane().querySelector<HTMLElement>('.command-region-cue.is-selected');
        const grid = rect(query('.xterm-screen'));
        assert('offscreen selected marker is clipped or removed', !old || old.getBoundingClientRect().height === 0 || !overlap(rect(old),grid));
        const buttons = pane().querySelectorAll<HTMLButtonElement>('.command-navigation-rail-controls button');
        buttons[1].click(); await settled();
        assert('Next brings exact confirmed offscreen region into view', selected() === 'b' && !!query('.command-region-cue.is-selected'));
        query('.command-navigation-rail-copy').click(); await settled();
        assert('Next also changes authoritative copy target', clipboardWrites.at(-1) === 'same command\noutput:b');
        value.visualAnchorCues.get('nonce-b').marker.dispose(); await settled();
        await until(() => selected() === 'a', 'disposed selection falls back to remaining valid id');
        return { results:[...results] };
    },
    async measure(width: number, height: number, count: number, orientation: string) {
        render(width,height,count,orientation); await settled();
        await until(() => owners.size === count, 'pane count ready');
        await settled();
        return { width,height,count,orientation,devicePixelRatio,viewport:{width:innerWidth,height:innerHeight},geometry:geometry() };
    },
    async searchCheck() {
        const props = owners.get('pane-0').searchProps;
        getDefaultStore().set(props.isOpen, true); await settled();
        await until(() => !!document.querySelector('.search-container'), 'actual production search mounted');
        const box = rect(document.querySelector('.search-container')!);
        assert('search does not cover Global Clear', !overlap(box,rect(query('.terminal-clear-action-button'))),box);
        assert('sticker overlay excludes action gutter', rect(query('.term-stickers')).right <= rect(query('.terminal-action-gutter')).left + .1);
    },
    async closeSearch() {
        const props = owners.get('pane-0').searchProps;
        getDefaultStore().set(props.isOpen, false); await settled();
    }
};
