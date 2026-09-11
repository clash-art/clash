import path from "node:path";
import {
  clickButtonByLabel,
  clickByText,
  createAgentBrowser,
  ensureAgentBrowser,
  evalJson,
  findFreePort,
  repoRoot,
  resetDirs,
  startElectron,
  startVite,
  stopProcess,
  tail,
  waitForEval,
  waitForHttp,
} from "./startup-shared.ts";

const captureDir =
  process.env.CLASH_DESKTOP_PROVIDER_GUI_CAPTURE_DIR ??
  path.join(repoRoot, ".tmp", "provider-gui-desktop-captures");
const dataDir =
  process.env.CLASH_DESKTOP_PROVIDER_GUI_DATA_DIR ??
  path.join(repoRoot, ".tmp", "provider-gui-desktop-data");
const sessionName = `clash-desktop-provider-gui-${Date.now().toString(36)}`;
const latestScreenshot = path.join(captureDir, "latest-provider-gui-desktop.png");

function captureEvidence(agentBrowser, name) {
  const screenshotPath = path.join(captureDir, `${name}.png`);
  evalJson(agentBrowser, `(() => {
    for (const el of [...document.body.querySelectorAll("*")]) {
      const style = getComputedStyle(el);
      const text = (el.innerText || el.textContent || "").trim();
      if (style.position === "fixed" && text.includes("Provider settings saved")) el.remove();
    }
    return true;
  })()`);
  agentBrowser(["screenshot", screenshotPath]);
  console.log(`[desktop-provider-gui] evidence ${name} ${screenshotPath}`);
  return screenshotPath;
}

async function seedMockProviders(apiOrigin) {
  const res = await fetch(`${apiOrigin}/api/v1/model-providers`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      providers: [
        {
          id: "mock-primary",
          label: "Mock primary",
          providerId: "mock",
          upstreamId: "mock",
          enabled: true,
          priority: 10,
        },
        {
          id: "mock-secondary",
          label: "Mock secondary",
          providerId: "mock",
          upstreamId: "mock",
          enabled: true,
          priority: 20,
        },
        {
          id: "replicate-primary",
          label: "Replicate primary",
          providerId: "replicate",
          upstreamId: "replicate",
          enabled: true,
          priority: 20,
          credentials: { apiKey: "r8-desktop-gui-key" },
        },
      ],
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`Could not seed desktop mock providers: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
}

function navigateTo(agentBrowser, pathname) {
  return evalJson(agentBrowser, `(() => {
    window.location.assign(${JSON.stringify(pathname)});
    return true;
  })()`);
}

function setInputValueByLabel(agentBrowser, label, value) {
  return evalJson(agentBrowser, `(() => {
    const wanted = ${JSON.stringify(label)};
    const input = [...document.querySelectorAll("input, textarea")].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const style = getComputedStyle(candidate);
      return candidate.getAttribute("aria-label") === wanted &&
        rect.width > 0 && rect.height > 0 &&
        style.display !== "none" && style.visibility !== "hidden" &&
        !candidate.disabled;
    });
    if (!input) return false;
    input.scrollIntoView({ block: "center", inline: "center" });
    input.focus();
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: ${JSON.stringify(value)}, inputType: "insertText" }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
}

function clickButtonInGroup(agentBrowser, groupLabel, buttonLabel) {
  return evalJson(agentBrowser, `(() => {
    const wantedGroup = ${JSON.stringify(groupLabel)};
    const wantedButton = ${JSON.stringify(buttonLabel)};
    const group = [...document.querySelectorAll("[role='group']")].find((candidate) =>
      candidate.getAttribute("aria-label") === wantedGroup
    );
    if (!group) return false;
    const button = [...group.querySelectorAll("button")].find((candidate) => {
      const text = (candidate.innerText || candidate.textContent || "").trim();
      const aria = candidate.getAttribute("aria-label") || "";
      const rect = candidate.getBoundingClientRect();
      const style = getComputedStyle(candidate);
      return (text === wantedButton || aria === wantedButton) &&
        rect.width > 0 && rect.height > 0 &&
        style.display !== "none" && style.visibility !== "hidden" &&
        !candidate.disabled;
    });
    if (!button) return false;
    button.scrollIntoView({ block: "center", inline: "center" });
    button.click();
    return true;
  })()`);
}

function openControlByLabel(agentBrowser, label) {
  return evalJson(agentBrowser, `(() => {
    const wanted = ${JSON.stringify(label)};
    const control = [...document.querySelectorAll("button, [role='combobox']")].find((el) => {
      const text = (el.innerText || el.textContent || "").trim();
      const aria = el.getAttribute("aria-label") || "";
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return (text === wanted || aria === wanted) &&
        rect.width > 0 && rect.height > 0 &&
        style.display !== "none" && style.visibility !== "hidden" &&
        !el.disabled;
    });
    if (!control) return false;
    control.scrollIntoView({ block: "center", inline: "center" });
    control.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerType: "mouse",
      button: 0,
    }));
    if (![...document.querySelectorAll("[role='listbox'], [role='menu']")].some((menu) => {
      const rect = menu.getBoundingClientRect();
      const style = getComputedStyle(menu);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    })) {
      control.click();
    }
    return true;
  })()`);
}

function clickMenuItemContaining(agentBrowser, text) {
  return evalJson(agentBrowser, `(() => {
    const wanted = ${JSON.stringify(text)};
    const item = [...document.querySelectorAll("[role='listbox'] [role='option'], [role='menu'] [role='menuitemradio'], [role='menu'] [role='menuitem']")].find((candidate) => {
      const value = (candidate.innerText || candidate.textContent || "").trim();
      const rect = candidate.getBoundingClientRect();
      const style = getComputedStyle(candidate);
      return value.includes(wanted) &&
        rect.width > 0 && rect.height > 0 &&
        style.display !== "none" && style.visibility !== "hidden" &&
        !candidate.disabled;
    });
    if (!item) return false;
    item.scrollIntoView({ block: "center", inline: "center" });
    item.click();
    return true;
  })()`);
}

function menuContainsText(agentBrowser, text) {
  return evalJson(agentBrowser, `(() => {
    const wanted = ${JSON.stringify(text)};
    return [...document.querySelectorAll("[role='listbox'] [role='option'], [role='menu'] [role='menuitemradio'], [role='menu'] [role='menuitem']")].some((candidate) => {
      const value = (candidate.innerText || candidate.textContent || "").trim();
      const rect = candidate.getBoundingClientRect();
      const style = getComputedStyle(candidate);
      return value.includes(wanted) &&
        rect.width > 0 && rect.height > 0 &&
        style.display !== "none" && style.visibility !== "hidden";
    });
  })()`);
}

function clickListboxOptionContaining(agentBrowser, text) {
  return evalJson(agentBrowser, `(() => {
    const wanted = ${JSON.stringify(text)};
    const item = [...document.querySelectorAll("[role='listbox'] [role='option']")].find((candidate) => {
      const value = (candidate.innerText || candidate.textContent || "").trim();
      const rect = candidate.getBoundingClientRect();
      const style = getComputedStyle(candidate);
      return value.includes(wanted) &&
        rect.width > 0 && rect.height > 0 &&
        style.display !== "none" && style.visibility !== "hidden" &&
        !candidate.disabled;
    });
    if (!item) return false;
    item.scrollIntoView({ block: "center", inline: "center" });
    item.click();
    return true;
  })()`);
}

async function runProviderFlow(agentBrowser, apiOrigin) {
  await seedMockProviders(apiOrigin);
  navigateTo(agentBrowser, "/settings?section=providers");
  await waitForEval(
    agentBrowser,
    `location.pathname === "/settings" &&
      location.search.includes("section=providers") &&
      document.body.innerText.includes("BYOK")`,
    "desktop BYOK providers settings",
    20000,
  );

  if (!clickButtonByLabel(agentBrowser, "Open Mock Provider BYOK settings")) {
    throw new Error("Could not open Mock Provider BYOK settings");
  }
  await waitForEval(agentBrowser, `document.body.innerText.includes("Mock primary")`, "desktop mock provider row");

  if (!clickButtonByLabel(agentBrowser, "Move Mock secondary up")) {
    throw new Error("Could not move secondary mock provider account up");
  }
  await waitForEval(
    agentBrowser,
    `fetch(${JSON.stringify(`${apiOrigin}/api/v1/model-providers`)})
      .then((res) => res.json())
      .then((json) => {
        const providers = json.providers ?? [];
        const primary = providers.find((provider) => provider.id === "mock-primary");
        const secondary = providers.find((provider) => provider.id === "mock-secondary");
        return primary?.priority === 20 && secondary?.priority === 10;
      })
      .catch(() => false)`,
    "desktop mock provider account order saved",
  );

  if (!clickButtonByLabel(agentBrowser, "Expand Mock primary")) {
    throw new Error("Could not expand Mock primary provider account");
  }
  await waitForEval(
    agentBrowser,
    `document.body.innerText.includes("Model to test") &&
      !!document.querySelector("button[aria-label='Run provider test']")`,
    "desktop mock provider test controls",
  );

  if (!openControlByLabel(agentBrowser, "Choose test model")) {
    throw new Error("Could not open desktop provider test model selector");
  }
  await waitForEval(
    agentBrowser,
    `(() => {
      const trigger = [...document.querySelectorAll("button")].find((el) =>
        el.getAttribute("aria-label") === "Choose test model"
      );
      const menu = [...document.querySelectorAll("[role='listbox'], [role='menu']")].find((el) =>
        (el.innerText || el.textContent || "").includes("Mock Image Model")
      );
      const search = document.querySelector("input[aria-label='Search test models']");
      if (!trigger || !menu || !search) return false;
      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const searchRect = search.getBoundingClientRect();
      return menu.getAttribute("role") === "listbox" &&
        trigger.tagName === "BUTTON" &&
        trigger.getAttribute("role") === "combobox" &&
        (menu.innerText || menu.textContent || "").includes("fal-ai/mock-image") &&
        (menu.innerText || menu.textContent || "").includes("image") &&
        menuRect.width >= Math.min(triggerRect.width, 160) &&
        menuRect.width > 180 &&
        menuRect.height > 40 &&
        searchRect.width > 160 &&
        searchRect.height > 24 &&
        menuRect.left <= triggerRect.right &&
        menuRect.right >= triggerRect.left;
    })()`,
    "desktop provider test model selector uses searchable combobox/listbox popup",
  );
  if (!setInputValueByLabel(agentBrowser, "Search test models", "image")) {
    throw new Error("Could not search desktop provider test model selector for image models");
  }
  await waitForEval(
    agentBrowser,
    `(() => {
      const menu = [...document.querySelectorAll("[role='listbox']")].find((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
      const text = menu ? (menu.innerText || menu.textContent || "") : "";
      return text.includes("Mock Image Model") && !text.includes("Mock Text Model");
    })()`,
    "desktop provider test model selector filters image models",
  );
  captureEvidence(agentBrowser, "00-test-model-selector-open");
  if (!clickMenuItemContaining(agentBrowser, "Mock Image Model")) {
    throw new Error("Could not select Mock Image Model for the desktop mock provider test");
  }
  await waitForEval(
    agentBrowser,
    `document.body.innerText.includes("Mock Image Model")`,
    "desktop mock provider selected test model",
  );
  if (!clickButtonByLabel(agentBrowser, "Run provider test")) {
    throw new Error("Could not run desktop mock provider test");
  }
  await waitForEval(
    agentBrowser,
    `document.body.innerText.includes("Mock provider ran Mock Image Model through fal-ai/mock-image.") &&
      document.body.innerText.includes('"shape": "image"') &&
      document.body.innerText.includes('"url":')`,
    "desktop mock provider test result",
  );
  captureEvidence(agentBrowser, "01-provider-test-image-result");

  if (!openControlByLabel(agentBrowser, "Choose test model")) {
    throw new Error("Could not reopen desktop provider test model selector for text shape");
  }
  if (!setInputValueByLabel(agentBrowser, "Search test models", "text")) {
    throw new Error("Could not search desktop provider test model selector for text models");
  }
  await waitForEval(
    agentBrowser,
    `(() => {
      const menu = [...document.querySelectorAll("[role='listbox']")].find((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
      const text = menu ? (menu.innerText || menu.textContent || "") : "";
      return text.includes("Mock Text Model") && !text.includes("Mock Image Model");
    })()`,
    "desktop provider test model selector filters text models",
  );
  if (!clickMenuItemContaining(agentBrowser, "Mock Text Model")) {
    throw new Error("Could not select Mock Text Model for the desktop mock provider test");
  }
  if (!clickButtonByLabel(agentBrowser, "Run provider test")) {
    throw new Error("Could not run desktop mock text provider test");
  }
  await waitForEval(
    agentBrowser,
    `document.body.innerText.includes("Mock provider ran Mock Text Model through mock/text-completion.") &&
      document.body.innerText.includes('"shape": "text"') &&
      document.body.innerText.includes('"text": "Generated text (mock-text-model)') &&
      !document.body.innerText.includes('"url": "http://local-provider-test/fal/media/')`,
    "desktop mock text provider test result",
  );
  captureEvidence(agentBrowser, "02-provider-test-text-result");

  if (!clickButtonByLabel(agentBrowser, "Model access")) {
    throw new Error("Could not open desktop model access selector");
  }
  if (!clickMenuItemContaining(agentBrowser, "Specific models")) {
    throw new Error("Could not switch desktop mock provider to specific model access");
  }
  await waitForEval(
    agentBrowser,
    `!!document.querySelector("button[aria-label='Add supported model']")`,
    "desktop specific model access controls",
  );
  if (!clickButtonByLabel(agentBrowser, "Add supported model")) {
    throw new Error("Could not open desktop supported model picker");
  }
  await waitForEval(
    agentBrowser,
    `!!document.querySelector("input[aria-label='Search supported models']") &&
      ![...document.querySelectorAll("[role='menu']")].some((el) =>
        el.getAttribute("aria-label") === "Add supported model"
      )`,
    "desktop supported model picker search",
  );
  if (!setInputValueByLabel(agentBrowser, "Search supported models", "gpt image")) {
    throw new Error("Could not filter desktop supported models");
  }
  if (!clickListboxOptionContaining(agentBrowser, "GPT Image 2")) {
    throw new Error("Could not add GPT Image 2 to the desktop mock provider allowlist");
  }
  await waitForEval(
    agentBrowser,
    `document.body.innerText.includes("GPT Image 2") && (() => {
      const editor = document.querySelector("[role='group'][aria-label='Mock primary Mock Provider API key']");
      return !![...(editor?.querySelectorAll("button") ?? [])].find((button) =>
        (button.innerText || button.textContent || "").trim() === "Save" && !button.disabled
      );
    })()`,
    "desktop mock provider model allowlist draft",
  );
  if (!clickButtonInGroup(agentBrowser, "Mock primary Mock Provider API key", "Save")) {
    throw new Error("Could not save desktop mock provider model allowlist");
  }
  await waitForEval(
    agentBrowser,
    `fetch(${JSON.stringify(`${apiOrigin}/api/v1/model-providers`)})
      .then((res) => res.json())
      .then((json) => json.providers?.some((provider) =>
        provider.id === "mock-primary" &&
        Array.isArray(provider.supportedModelIds) &&
        provider.supportedModelIds.length === 1 &&
        provider.supportedModelIds[0] === "gpt-image-2"
      ))
      .catch(() => false)`,
    "desktop mock provider model allowlist saved",
  );
  if (!openControlByLabel(agentBrowser, "Choose test model")) {
    throw new Error("Could not reopen desktop provider test model selector after saving allowlist");
  }
  await waitForEval(
    agentBrowser,
    `(() => {
      const items = [...document.querySelectorAll("[role='listbox'] [role='option'], [role='menu'] [role='menuitemradio'], [role='menu'] [role='menuitem']")]
        .map((item) => (item.innerText || item.textContent || "").trim());
      return items.some((item) => item.includes("GPT Image 2"));
    })()`,
    "desktop scoped provider test model selector",
  );
  if (menuContainsText(agentBrowser, "Nano Banana 2")) {
    throw new Error("Desktop provider test model selector exposed a model outside the saved allowlist");
  }

  if (!clickByText(agentBrowser, "View supported models")) {
    throw new Error("Could not open desktop supported models link");
  }
  await waitForEval(
    agentBrowser,
    `location.pathname === "/settings" &&
      location.search.includes("section=models") &&
      location.search.includes("provider=mock%3Amock%3A") &&
      document.body.innerText.includes("Models supported by Mock Provider")`,
    "desktop mock supported models page",
  );
  captureEvidence(agentBrowser, "03-supported-models-page");

  if (!clickButtonByLabel(agentBrowser, "Edit provider order for GPT Image 2")) {
    throw new Error("Could not open desktop GPT Image 2 provider order");
  }
  await waitForEval(
    agentBrowser,
    `!!document.querySelector("[aria-label='GPT Image 2 provider order']")`,
    "desktop GPT Image 2 provider order",
  );
  if (!clickButtonByLabel(agentBrowser, "Move Replicate up for GPT Image 2")) {
    throw new Error("Could not move Replicate up for GPT Image 2 in desktop settings");
  }
  await waitForEval(
    agentBrowser,
    `fetch(${JSON.stringify(`${apiOrigin}/api/v1/model-providers`)})
      .then((res) => res.json())
      .then((json) => {
        const providers = json.providers ?? [];
        const replicate = providers.find((provider) => provider.id === "replicate-primary");
        const mock = providers.find((provider) => provider.id === "mock-primary");
        return replicate?.modelPriorities?.["gpt-image-2"] === 10 &&
          mock?.modelPriorities?.["gpt-image-2"] === 20;
      })
      .catch(() => false)`,
    "desktop GPT Image 2 provider order saved",
  );
  captureEvidence(agentBrowser, "04-model-provider-order-saved");

  navigateTo(agentBrowser, "/settings?section=providers");
  await waitForEval(agentBrowser, `document.body.innerText.includes("BYOK")`, "desktop BYOK providers after model order");
  if (!clickButtonByLabel(agentBrowser, "Open Replicate BYOK settings")) {
    throw new Error("Could not open Replicate BYOK settings");
  }
  await waitForEval(agentBrowser, `document.body.innerText.includes("Replicate primary")`, "desktop Replicate provider row");
  if (!clickButtonByLabel(agentBrowser, "Add prioritized Replicate key")) {
    throw new Error("Could not add a Replicate provider key");
  }
  await waitForEval(
    agentBrowser,
    `!!document.querySelector("[role='group'][aria-label='New Replicate API key']")`,
    "desktop new Replicate key editor",
  );
  if (!setInputValueByLabel(agentBrowser, "Replicate key name", "Desktop smoke key")) {
    throw new Error("Could not enter Replicate key name");
  }
  if (!setInputValueByLabel(agentBrowser, "Replicate API key", "r8-desktop-smoke-extra-key")) {
    throw new Error("Could not enter Replicate API key");
  }
  if (!clickButtonInGroup(agentBrowser, "New Replicate API key", "Save")) {
    throw new Error("Could not save the Replicate key draft");
  }
  await waitForEval(
    agentBrowser,
    `fetch(${JSON.stringify(`${apiOrigin}/api/v1/model-providers`)})
      .then((res) => res.json())
      .then((json) => (json.providers ?? []).some((provider) =>
        provider.providerId === "replicate" &&
        provider.label === "Desktop smoke key" &&
        provider.configuredCredentials?.includes("apiKey")
      ))
      .catch(() => false)`,
    "desktop Replicate key saved",
  );
  await waitForEval(agentBrowser, `document.body.innerText.includes("Desktop smoke key")`, "desktop saved Replicate key visible");
  if (!clickButtonByLabel(agentBrowser, "Expand Desktop smoke key")) {
    throw new Error("Could not expand the saved desktop Replicate key");
  }
  await waitForEval(
    agentBrowser,
    `!!document.querySelector("[role='group'][aria-label='Desktop smoke key Replicate API key']")`,
    "desktop saved Replicate key editor",
  );
  if (!clickButtonInGroup(agentBrowser, "Desktop smoke key Replicate API key", "Remove key")) {
    throw new Error("Could not remove the saved desktop Replicate key");
  }
  await waitForEval(
    agentBrowser,
    `fetch(${JSON.stringify(`${apiOrigin}/api/v1/model-providers`)})
      .then((res) => res.json())
      .then((json) => {
        const providers = json.providers ?? [];
        return providers.some((provider) => provider.id === "replicate-primary") &&
          !providers.some((provider) => provider.providerId === "replicate" && provider.label === "Desktop smoke key");
      })
      .catch(() => false)`,
    "desktop Replicate key removed",
  );

  navigateTo(agentBrowser, "/settings?section=providers");
  await waitForEval(agentBrowser, `document.body.innerText.includes("BYOK")`, "desktop BYOK providers before OpenAI multi-key");
  if (!clickButtonByLabel(agentBrowser, "Open OpenAI BYOK settings")) {
    throw new Error("Could not open OpenAI BYOK settings");
  }
  await waitForEval(agentBrowser, `document.body.innerText.includes("OpenAI")`, "desktop OpenAI provider detail");

  if (!clickButtonByLabel(agentBrowser, "Add prioritized OpenAI key")) {
    throw new Error("Could not add the first OpenAI key");
  }
  await waitForEval(
    agentBrowser,
    `!!document.querySelector("[role='group'][aria-label='New OpenAI API key']")`,
    "desktop first new OpenAI key editor",
  );
  if (!setInputValueByLabel(agentBrowser, "OpenAI key name", "OpenAI smoke key 1")) {
    throw new Error("Could not enter first OpenAI key name");
  }
  if (!setInputValueByLabel(agentBrowser, "OpenAI API key", "sk-desktop-smoke-openai-1")) {
    throw new Error("Could not enter first OpenAI key");
  }
  if (!clickButtonInGroup(agentBrowser, "New OpenAI API key", "Save")) {
    throw new Error("Could not save first OpenAI key");
  }
  await waitForEval(
    agentBrowser,
    `fetch(${JSON.stringify(`${apiOrigin}/api/v1/model-providers`)})
      .then((res) => res.json())
      .then((json) => (json.providers ?? []).some((provider) =>
        provider.providerId === "official" &&
        provider.upstreamId === "openai" &&
        provider.region === "global" &&
        provider.label === "OpenAI smoke key 1" &&
        typeof provider.id === "string" &&
        provider.id.length > 0
      ))
      .catch(() => false)`,
    "desktop first OpenAI key saved with id",
  );

  if (!clickButtonByLabel(agentBrowser, "Add prioritized OpenAI key")) {
    throw new Error("Could not add the second OpenAI key");
  }
  await waitForEval(
    agentBrowser,
    `!!document.querySelector("[role='group'][aria-label='New OpenAI API key']")`,
    "desktop second new OpenAI key editor",
  );
  if (!setInputValueByLabel(agentBrowser, "OpenAI key name", "OpenAI smoke key 2")) {
    throw new Error("Could not enter second OpenAI key name");
  }
  if (!setInputValueByLabel(agentBrowser, "OpenAI API key", "sk-desktop-smoke-openai-2")) {
    throw new Error("Could not enter second OpenAI key");
  }
  if (!clickButtonInGroup(agentBrowser, "New OpenAI API key", "Save")) {
    throw new Error("Could not save second OpenAI key");
  }
  await waitForEval(
    agentBrowser,
    `fetch(${JSON.stringify(`${apiOrigin}/api/v1/model-providers`)})
      .then((res) => res.json())
      .then((json) => {
        const providers = (json.providers ?? []).filter((provider) =>
          provider.providerId === "official" &&
          provider.upstreamId === "openai" &&
          provider.region === "global" &&
          (provider.label === "OpenAI smoke key 1" || provider.label === "OpenAI smoke key 2")
        );
        return providers.length === 2 &&
          providers.every((provider) => typeof provider.id === "string" && provider.id.length > 0) &&
          new Set(providers.map((provider) => provider.id)).size === 2;
      })
      .catch(() => false)`,
    "desktop two OpenAI keys saved with distinct ids",
  );
  captureEvidence(agentBrowser, "05-two-openai-keys-saved");

  return evalJson(agentBrowser, `(() => ({
    href: location.href,
    text: document.body.innerText.slice(0, 900),
    providers: window.__CLASH_RUNTIME_CONFIG__?.apiBaseUrl ? "desktop-api" : "missing-runtime"
  }))()`);
}

async function main() {
  ensureAgentBrowser();
  process.env.CLASH_E2E_STUB_ACP = "1";
  await resetDirs(dataDir, captureDir);

  const webPort = await findFreePort(49880);
  const apiPort = await findFreePort(49930);
  const cdpPort = await findFreePort(49980);
  const webOrigin = `http://127.0.0.1:${webPort}`;

  const webLogs = [];
  const electronLogs = [];
  let web;
  let electron;
  const agentBrowser = createAgentBrowser({ sessionName, captureDir });

  try {
    web = await startVite({ webPort, logs: webLogs });
    await waitForHttp(webOrigin, "Vite desktop provider web shell");

    electron = await startElectron({
      cdpPort,
      webOrigin,
      apiPort,
      dataDir,
      captureDir,
      logs: electronLogs,
      env: { CLASH_E2E_STUB_ACP: "1" },
    });
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, "Electron CDP");

    agentBrowser(["close"], { allowFailure: true });
    agentBrowser(["connect", String(cdpPort)]);
    await waitForEval(agentBrowser, `document.body.innerText.includes("Home")`, "desktop home page");
    const runtime = await waitForEval(
      agentBrowser,
      `(() => window.__CLASH_RUNTIME_CONFIG__?.apiBaseUrl ? window.__CLASH_RUNTIME_CONFIG__ : false)()`,
      "Electron desktop runtime config",
    );

    const state = await runProviderFlow(agentBrowser, runtime.apiBaseUrl);
    agentBrowser(["screenshot", latestScreenshot]);
    console.log("[desktop-provider-gui] state", JSON.stringify(state));
    console.log(`[desktop-provider-gui] screenshot ${latestScreenshot}`);
  } catch (error) {
    try {
      agentBrowser(["screenshot", latestScreenshot], { allowFailure: true });
      console.error(`[desktop-provider-gui] failure screenshot ${latestScreenshot}`);
    } catch {
      // Ignore screenshot failure while unwinding.
    }
    console.error("[desktop-provider-gui] web logs\n" + tail(webLogs));
    console.error("[desktop-provider-gui] electron logs\n" + tail(electronLogs));
    throw error;
  } finally {
    agentBrowser(["close"], { allowFailure: true });
    await stopProcess(electron);
    await stopProcess(web);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
