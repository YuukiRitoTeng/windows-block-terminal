# Block System

Wave Block is the terminal-session unit. Block controllers, block metadata and block files are shared by terminal views and RPC. B2+ must keep this semantic unchanged and layer CommandRecord outside waveobj.Block; Command Cards are projections of completed records.