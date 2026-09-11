import path from "node:path";

import {
  waitForEval,
} from "./startup-shared.ts";

const PRODUCT_TRIGGER_IDS = {
  run: "session-harness-config-trigger",
  permission: "session-permission-mode-trigger",
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function configOptions(agent) {
  return Array.isArray(agent?.config_options)
    ? agent.config_options.filter((option) => option && typeof option === "object")
    : [];
}

function availableCommands(agent) {
  return Array.isArray(agent?.available_commands)
    ? agent.available_commands.filter(
        (command) => command && typeof command.name === "string",
      )
    : [];
}

function selectValues(option) {
  if (option?.type !== "select" || !Array.isArray(option.options)) return [];
  return option.options.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    if (Array.isArray(entry.options)) {
      return entry.options.flatMap((value) => (
        value
        && typeof value === "object"
        && typeof value.value === "string"
        && typeof value.name === "string"
          ? [{
              value: value.value,
              name: value.name,
              ...(typeof value.description === "string"
                ? { description: value.description }
                : {}),
            }]
          : []
      ));
    }
    return typeof entry.value === "string" && typeof entry.name === "string"
      ? [{
          value: entry.value,
          name: entry.name,
          ...(typeof entry.description === "string"
            ? { description: entry.description }
            : {}),
        }]
      : [];
  });
}

function isValidOptionValue(option, value) {
  if (option?.type === "boolean") return typeof value === "boolean";
  return typeof value === "string"
    && selectValues(option).some((candidate) => candidate.value === value);
}

function withRecentValue(option, recentValue) {
  return isValidOptionValue(option, recentValue)
    ? { ...option, currentValue: recentValue }
    : { ...option };
}

function selectionForOption(option) {
  if (!option) return null;
  if (option.type === "boolean" && typeof option.currentValue === "boolean") {
    return {
      value: option.currentValue,
      name: option.currentValue ? "On" : "Off",
    };
  }
  if (option.type !== "select" || typeof option.currentValue !== "string") {
    return null;
  }
  const selected = selectValues(option).find(
    (candidate) => candidate.value === option.currentValue,
  );
  return selected
    ? { value: selected.value, name: selected.name }
    : null;
}

function findOption(options, predicate) {
  return options.find(predicate) ?? null;
}

function profileOptionMap(options) {
  return {
    model: findOption(
      options,
      (option) => option.type === "select" && option.category === "model",
    ),
    effort: findOption(
      options,
      (option) => option.type === "select" && option.category === "thought_level",
    ),
    fastMode: findOption(
      options,
      (option) => option.id === "fast-mode"
        && (option.type === "select" || option.type === "boolean"),
    ),
    permission: findOption(
      options,
      (option) => option.type === "select"
        && (option.category === "mode" || option.id === "mode"),
    ),
    collaboration: findOption(
      options,
      (option) => option.type === "select" && option.id === "collaboration_mode",
    ),
  };
}

export function resolveHarnessProductProfile(
  snapshot,
  { runtimeId = "desktop-local", harnessId },
) {
  invariant(
    typeof harnessId === "string" && harnessId.length > 0,
    "Cold-start product profile requires a harnessId",
  );
  const runtimes = Array.isArray(snapshot?.runtimes) ? snapshot.runtimes : [];
  const runtime = runtimes.find((candidate) => candidate?.id === runtimeId);
  invariant(runtime, `Cold-start runtime snapshot is missing ${runtimeId}`);

  const agents = Array.isArray(runtime.agents) ? runtime.agents : [];
  const harness = agents.find((candidate) => candidate?.id === harnessId);
  invariant(harness, `Cold-start runtime snapshot is missing harness ${harnessId}`);

  const recentConfig = runtime.preferences?.config_by_agent?.[harnessId];
  let resolvedOptions = configOptions(harness).map((option) => (
    withRecentValue(option, recentConfig?.[option.id])
  ));
  const initialMap = profileOptionMap(resolvedOptions);
  const recentPermission = runtime.preferences?.mode_by_agent?.[harnessId];
  if (
    initialMap.permission
    && isValidOptionValue(initialMap.permission, recentPermission)
  ) {
    resolvedOptions = resolvedOptions.map((option) => (
      option.id === initialMap.permission.id
        ? { ...option, currentValue: recentPermission }
        : option
    ));
  }

  const optionMap = profileOptionMap(resolvedOptions);
  return {
    runtimeId,
    harnessId,
    harnessLabel: typeof harness.label === "string" && harness.label.length > 0
      ? harness.label
      : harnessId,
    auth: harness.auth ?? null,
    availableCommands: availableCommands(harness),
    configOptions: resolvedOptions,
    selectionOptionIds: Object.fromEntries(
      Object.entries(optionMap).flatMap(([key, option]) => (
        option ? [[key, option.id]] : []
      )),
    ),
    selections: Object.fromEntries(
      Object.entries(optionMap).flatMap(([key, option]) => {
        const selection = selectionForOption(option);
        return selection ? [[key, selection]] : [];
      }),
    ),
  };
}

function alternateSelection(option) {
  if (!option) return null;
  if (option.type === "boolean" && typeof option.currentValue === "boolean") {
    const value = !option.currentValue;
    return { value, name: value ? "On" : "Off" };
  }
  if (option.type !== "select") return null;
  const alternate = selectValues(option).find(
    (candidate) => candidate.value !== option.currentValue,
  );
  return alternate
    ? { value: alternate.value, name: alternate.name }
    : null;
}

export function chooseAlternateRunPreferences(profile) {
  invariant(profile && typeof profile === "object", "Run preference profile is required");
  const optionMap = profileOptionMap(profile.configOptions ?? []);
  const selections = {};
  const configValues = {};

  for (const [key, option] of Object.entries(optionMap)) {
    const selection = alternateSelection(option);
    if (!option || !selection) continue;
    selections[key] = selection;
    configValues[option.id] = selection.value;
  }

  invariant(
    Object.keys(configValues).length > 0,
    `Harness ${profile.harnessId} exposes no alternate run preferences`,
  );
  return {
    harnessId: profile.harnessId,
    configValues,
    ...(selections.permission
      ? { permissionMode: selections.permission.value }
      : {}),
    selections,
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${url} -> HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }
  return JSON.parse(text);
}

async function runtimeSessionCount(apiOrigin, projectId) {
  const response = await fetchJson(
    `${apiOrigin}/api/v1/sessions?projectId=${encodeURIComponent(projectId)}`,
  );
  const sessions = Array.isArray(response?.sessions)
    ? response.sessions
    : Array.isArray(response)
      ? response
      : [];
  return sessions.filter((session) => session?.type === "runtime").length;
}

function triggerObservationExpression(requiredKeys) {
  const requiredIds = Object.fromEntries(
    requiredKeys.map((key) => [key, PRODUCT_TRIGGER_IDS[key]]),
  );
  return `(() => {
    const required = ${JSON.stringify(requiredIds)};
    const observed = {};
    for (const [key, testId] of Object.entries(required)) {
      const trigger = document.querySelector(\`[data-testid="\${testId}"]\`);
      if (!trigger) return false;
      const rect = trigger.getBoundingClientRect();
      const style = getComputedStyle(trigger);
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        trigger.disabled
      ) return false;
      observed[key] = {
        text: (trigger.innerText || trigger.textContent || "").replace(/\\s+/g, " ").trim(),
        ariaLabel: trigger.getAttribute("aria-label") || "",
        state: trigger.getAttribute("data-state") || "",
      };
    }
    return observed;
  })()`;
}

async function readOpenMenu(agentBrowser, testId, expectedTexts = []) {
  const selector = `[data-testid="${testId}"]`;
  agentBrowser(["click", selector]);
  const menu = await waitForEval(
    agentBrowser,
    `(() => {
      const trigger = document.querySelector(${JSON.stringify(selector)});
      const label = trigger?.getAttribute("aria-label");
      const openMenu = [...document.querySelectorAll('[role="menu"][data-state="open"]')]
        .find((candidate) => candidate.getAttribute("aria-label") === label);
      const rect = openMenu?.getBoundingClientRect();
      if (!openMenu || !rect || rect.width <= 0 || rect.height <= 0) return false;
      const text = (openMenu.innerText || openMenu.textContent || "").replace(/\\s+/g, " ").trim();
      const expected = ${JSON.stringify(expectedTexts)};
      if (!expected.every((value) => text.includes(value))) return false;
      const items = [...openMenu.querySelectorAll('[role="menuitemradio"]')].map((item) => {
        const labelElement = [...item.querySelectorAll("span")]
          .find((span) => span.classList.contains("font-medium"));
        const itemText = (item.innerText || item.textContent || "").replace(/\\s+/g, " ").trim();
        return {
          label: (labelElement?.innerText || labelElement?.textContent || itemText)
            .replace(/\\s+/g, " ")
            .trim(),
          text: itemText,
          checked: item.getAttribute("aria-checked") === "true"
            || item.getAttribute("data-state") === "checked",
        };
      });
      return { label, text, items };
    })()`,
    `${testId} product menu`,
    20_000,
  );
  agentBrowser(["press", "Escape"]);
  await waitForEval(
    agentBrowser,
    `document.querySelector(${JSON.stringify(selector)})?.getAttribute("data-state") === "closed"`,
    `${testId} menu closed`,
    10_000,
  );
  return menu;
}

function assertSelectedTrigger(trigger, menu, description) {
  const selected = menu.items.find((item) => item.checked);
  invariant(selected, `${description} menu has no selected item`);
  invariant(
    trigger.text.includes(selected.label),
    `${description} trigger ${JSON.stringify(trigger.text)} does not match selected menu item ${
      JSON.stringify(selected.label)
    }`,
  );
}

function expectedRunLabels(profile) {
  return [
    ["model", "Model"],
    ["effort", "Effort"],
    ["fastMode", "Fast mode"],
  ].flatMap(([key, label]) => {
    const selection = profile.selections[key];
    return selection ? [label, selection.name] : [];
  });
}

async function observeProductSelectors(agentBrowser, profile, description) {
  const requiredKeys = ["run"];
  if (profile.selections.permission) requiredKeys.push("permission");

  const triggers = await waitForEval(
    agentBrowser,
    triggerObservationExpression(requiredKeys),
    description,
    30_000,
  );
  const runTriggerLabel = profile.selections.model?.name ?? profile.harnessLabel;
  invariant(
    triggers.run.text.includes(runTriggerLabel),
    `Run trigger must show the live selected value ${JSON.stringify(runTriggerLabel)}; received ${
      JSON.stringify(triggers.run.text)
    }`,
  );

  const runMenu = await readOpenMenu(
    agentBrowser,
    PRODUCT_TRIGGER_IDS.run,
    expectedRunLabels(profile),
  );
  const menus = { run: runMenu };

  if (profile.selections.permission) {
    const permissionMenu = await readOpenMenu(
      agentBrowser,
      PRODUCT_TRIGGER_IDS.permission,
    );
    assertSelectedTrigger(triggers.permission, permissionMenu, "Permission");
    menus.permission = permissionMenu;
  }

  const states = {};
  if (profile.selections.collaboration) {
    const planCommand = profile.availableCommands.find(
      (command) => command.name === "plan",
    );
    invariant(
      planCommand,
      `Harness ${profile.harnessId} exposes collaboration_mode without the /plan command`,
    );
    const expectsPlanTag = profile.selections.collaboration.value === "plan";
    states.collaboration = await waitForEval(
      agentBrowser,
      `(() => {
        const tag = document.querySelector('[data-testid="session-plan-tag"]');
        const rect = tag?.getBoundingClientRect();
        const visible = !!tag && !!rect && rect.width > 0 && rect.height > 0 &&
          getComputedStyle(tag).display !== "none" &&
          getComputedStyle(tag).visibility !== "hidden";
        if (visible !== ${JSON.stringify(expectsPlanTag)}) return false;
        if (visible && !tag.querySelector('button[aria-label="Exit Plan mode"]')) return false;
        return {
          command: "/plan",
          value: ${JSON.stringify(profile.selections.collaboration.value)},
          tagVisible: visible,
          text: visible
            ? (tag.innerText || tag.textContent || "").replace(/\\s+/g, " ").trim()
            : "",
        };
      })()`,
      `${description} Plan command state`,
      10_000,
    );
  }

  return { triggers, menus, states };
}

export async function assertColdStartProductContract({
  agentBrowser,
  apiOrigin,
  projectId,
  clashHome,
  harnessId,
  runtimeId = "desktop-local",
}) {
  const sessionsBefore = await runtimeSessionCount(apiOrigin, projectId);
  invariant(
    sessionsBefore === 0,
    `Cold-start capability discovery created ${sessionsBefore} product runtime session(s)`,
  );

  // This is deliberately the ordinary snapshot endpoint. A refresh probe here
  // would hide the exact lifecycle regression this E2E exists to catch.
  const runtimeSnapshot = await fetchJson(`${apiOrigin}/api/v1/runtimes`);
  const profile = resolveHarnessProductProfile(runtimeSnapshot, {
    runtimeId,
    harnessId,
  });
  const selectors = await observeProductSelectors(
    agentBrowser,
    profile,
    "cold-start run and permission controls",
  );

  const sessionsAfter = await runtimeSessionCount(apiOrigin, projectId);
  invariant(
    sessionsAfter === 0,
    `Opening cold-start selectors created ${sessionsAfter} product runtime session(s)`,
  );

  const projectStatus = await fetchJson(
    `${apiOrigin}/api/v1/projects/${encodeURIComponent(projectId)}/status`,
  );
  if (clashHome) {
    const expectedRoot = `${path.resolve(clashHome)}${path.sep}`;
    for (const [label, candidate] of [
      ["project workspace", projectStatus?.projectWorkspaceRoot],
      ["local SQLite", projectStatus?.localSqlitePath],
    ]) {
      invariant(
        typeof candidate === "string"
          && `${path.resolve(candidate)}${path.sep}`.startsWith(expectedRoot),
        `Cold-start ${label} escaped CLASH_HOME: ${JSON.stringify(candidate)}`,
      );
    }
  }

  return {
    profile,
    triggers: selectors.triggers,
    states: selectors.states,
    menus: Object.fromEntries(
      Object.entries(selectors.menus).map(([key, menu]) => [key, menu.text]),
    ),
    sessionsBefore,
    sessionsAfter,
    projectStatus: {
      projectWorkspaceRoot: projectStatus?.projectWorkspaceRoot ?? null,
      localSqlitePath: projectStatus?.localSqlitePath ?? null,
    },
  };
}

export async function assertRecentRunPreferencesProductContract({
  agentBrowser,
  apiOrigin,
  projectId,
  harnessId,
  expectedPreferences,
  sessionsBeforeRestart,
  runtimeId = "desktop-local",
}) {
  invariant(
    expectedPreferences?.harnessId === harnessId,
    "Expected preferences do not belong to the restarted harness",
  );
  const runtimeSnapshot = await fetchJson(`${apiOrigin}/api/v1/runtimes`);
  const runtime = runtimeSnapshot?.runtimes?.find(
    (candidate) => candidate?.id === runtimeId,
  );
  invariant(runtime, `Restarted product snapshot is missing ${runtimeId}`);
  const preferences = runtime.preferences;
  invariant(
    preferences?.agent_id === harnessId,
    `Restarted product did not restore ${harnessId} as the recent harness: ${
      JSON.stringify(preferences)
    }`,
  );
  const recentConfig = preferences?.config_by_agent?.[harnessId];
  for (const [id, expected] of Object.entries(expectedPreferences.configValues)) {
    invariant(
      recentConfig?.[id] === expected,
      `Restarted product preference ${id} must be ${JSON.stringify(expected)}; received ${
        JSON.stringify(recentConfig?.[id])
      }`,
    );
  }
  if (expectedPreferences.permissionMode !== undefined) {
    invariant(
      preferences?.mode_by_agent?.[harnessId] === expectedPreferences.permissionMode,
      `Restarted product did not restore the recent permission mode ${
        JSON.stringify(expectedPreferences.permissionMode)
      }`,
    );
  }

  const sessionsAfterRestart = await runtimeSessionCount(apiOrigin, projectId);
  invariant(
    sessionsAfterRestart === sessionsBeforeRestart,
    `Cold restart created a product runtime session: ${
      sessionsBeforeRestart
    } -> ${sessionsAfterRestart}`,
  );

  const profile = resolveHarnessProductProfile(runtimeSnapshot, {
    runtimeId,
    harnessId,
  });
  for (const [key, expected] of Object.entries(expectedPreferences.selections)) {
    invariant(
      profile.selections[key]?.value === expected.value,
      `Restarted ${key} selection must be ${JSON.stringify(expected.value)}; received ${
        JSON.stringify(profile.selections[key]?.value)
      }`,
    );
  }
  const selectors = await observeProductSelectors(
    agentBrowser,
    profile,
    "recent run and permission controls after cold restart",
  );

  const sessionsAfterSelectors = await runtimeSessionCount(apiOrigin, projectId);
  invariant(
    sessionsAfterSelectors === sessionsBeforeRestart,
    `Opening selectors after restart created a product runtime session: ${
      sessionsBeforeRestart
    } -> ${sessionsAfterSelectors}`,
  );

  return {
    sessionsBeforeRestart,
    sessionsAfterRestart,
    sessionsAfterSelectors,
    preferences,
    profile,
    triggers: selectors.triggers,
    states: selectors.states,
    menus: Object.fromEntries(
      Object.entries(selectors.menus).map(([key, menu]) => [key, menu.text]),
    ),
  };
}
