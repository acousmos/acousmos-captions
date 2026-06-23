/** chrome.i18n with a safe fallback to the key (visible, greppable). */
export function t(key: string): string {
	const msg = chrome.i18n.getMessage(key);
	return msg || key;
}
