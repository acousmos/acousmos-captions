/**
 * Dev-only hot reload. `pnpm dev` runs a local WebSocket server that pushes a
 * message on every rebuild; here the service worker holds that connection (which
 * also keeps the SW alive) and reloads the whole extension when signalled. The
 * `__DEV__` guard means esbuild strips all of this from production builds.
 */
export function initDevReload(): void {
	if (!__DEV__) return;
	const connect = (): void => {
		let ws: WebSocket;
		try {
			ws = new WebSocket("ws://127.0.0.1:35729");
		} catch {
			setTimeout(connect, 1500);
			return;
		}
		ws.onmessage = (e) => {
			if (e.data === "reload") chrome.runtime.reload();
			// other messages (e.g. 'ping') just keep the connection — and the SW — alive
		};
		ws.onerror = () => ws.close();
		ws.onclose = () => setTimeout(connect, 1500);
	};
	connect();
}
