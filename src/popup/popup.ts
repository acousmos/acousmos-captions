import type { RuntimeResponse } from "../shared/messages";
import { t } from "../shared/i18n";
import { loadSettings, saveSettings } from "../shared/settings";

for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
	el.textContent = t(el.dataset["i18n"]!);
}

const versionEl = document.getElementById("version")!;
versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

const hint = document.getElementById("hint")!;
const enabled = document.getElementById("enabled") as HTMLInputElement;

void (async () => {
	const settings = await loadSettings();
	enabled.checked = settings.display.enabled;

	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	const onX = /https:\/\/(x|twitter|mobile\.twitter)\.com\//.test(
		tab?.url ?? "",
	);

	const status = (await chrome.runtime.sendMessage({
		kind: "keys/status",
	})) as RuntimeResponse;
	const keysOk =
		status.kind === "keys/status" &&
		status.asrConfigured &&
		status.llmConfigured;

	if (!keysOk) {
		hint.textContent = t("popup_keys_missing");
		hint.classList.add("warn");
	} else {
		hint.textContent = onX ? t("popup_ready") : t("popup_not_x");
	}
})();

enabled.addEventListener("change", () => {
	void loadSettings().then((s) => {
		s.display.enabled = enabled.checked;
		return saveSettings(s);
	});
});

document.getElementById("open-options")!.addEventListener("click", () => {
	void chrome.runtime.openOptionsPage();
});
