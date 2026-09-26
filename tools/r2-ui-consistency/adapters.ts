import { atom, createStore } from 'jotai';

export const calls: unknown[] = [];
export let records: any[] = [];
export let failClear = false;
export const clipboardWrites: string[] = [];
export function setFailClear(value: boolean) { failClear = value; }
export function setRecords(next: any[]) { records = next; }
export const CommandJournalService = {
    async ListVisibleRecords(blockId: string) { return records.filter(r => r.wave_block_id === blockId); },
    async GetOutput(id: string) { calls.push(['GetOutput', id]); return { data: btoa(`output:${id}`) }; },
    async ClearVisualHistory(id: string) { calls.push(['ClearVisualHistory', id]); if (failClear) throw new Error('controlled clear failure'); records = records.filter(r => r.wave_block_id !== id); },
};
const forbidden = () => { throw new Error('Unexpected application I/O in isolated harness'); };
export const RpcApi = new Proxy({}, { get: () => forbidden });
export const TabRpcClient = {};
export const BlockService = new Proxy({}, { get: () => forbidden });
export const globalStore = createStore();
export const getSettingsKeyAtom = () => atom(null);
export const getOverrideConfigAtom = () => atom(null);
export const getBlockMetaKeyAtom = () => atom(null);
export const getBlockTermDurableAtom = () => atom(false);
export const isDev = () => false;
export const getApi = () => ({ getPlatform: () => 'win32', writeClipboard: forbidden });
export const fetchWaveFile = forbidden;
export const openLink = forbidden;
export const createBlock = forbidden;
export const recordTEvent = forbidden;
export const setBadge = forbidden;
export const getFileSubject = forbidden;
export const waveEventSubscribeSingle = forbidden;
export const WOS = { makeORef: (type: string, id: string) => `${type}:${id}` };
