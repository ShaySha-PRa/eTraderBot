// @vitest-environment jsdom

import type { Bot, HandoffPackage, HandoffReceipt } from "@rakazo/contracts";
import type * as UiWeb from "@rakazo/ui-web";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  experienceHandoff: {
    catalog: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    packages: vi.fn(),
    preview: vi.fn(),
    confirm: vi.fn(),
    history: vi.fn(),
    importDetail: vi.fn(),
    revoke: vi.fn(),
    skills: vi.fn(),
    updateSkill: vi.fn(),
  },
}));
vi.mock("../lib/rpc", () => ({
  rpc: api,
  rpcForSpace: () => api,
  createSpaceRpc: () => api,
  selectedSpaceId: () => null,
}));
/** The interface language; switching it re-renders like the real provider does. */
const language = vi.hoisted(() => ({ locale: "en", listeners: new Set<() => void>() }));
vi.mock("@lingui/react/macro", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    language.listeners.add(listener);
    return () => language.listeners.delete(listener);
  };
  return {
    useLingui: () => {
      const locale = useSyncExternalStore(subscribe, () => language.locale);
      // Stand-in translation: other locales mark the source text with their code.
      const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
        (locale === "en" ? "" : `[${locale}] `) +
        parts.reduce((text, part, index) => text + part + String(values[index] ?? ""), "");
      return { t, i18n: { locale } };
    },
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});

async function switchLanguage(locale: string) {
  await act(async () => {
    language.locale = locale;
    for (const listener of language.listeners) listener();
  });
}
vi.mock("@rakazo/ui-web", async (importOriginal) => ({
  ...(await importOriginal<typeof UiWeb>()),
  Button: (props: ComponentProps<"button">) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  SectionHeading: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  } & Omit<ComponentProps<"input">, "checked">) => (
    <input
      type="checkbox"
      {...props}
      checked={checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
    />
  ),
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  } & Omit<ComponentProps<"input">, "checked">) => (
    <input
      type="checkbox"
      role="switch"
      aria-checked={checked}
      {...props}
      checked={checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
    />
  ),
}));

import { ExperienceHandoffPage } from "./ExperienceHandoff";

const source = { id: "source-bot", spaceId: "space-a", name: "Source" } as Bot;
const target = { id: "target-bot", spaceId: "space-b", name: "Target" } as Bot;

function pkg(overrides: Partial<HandoffPackage> = {}): HandoffPackage {
  return {
    id: "pkg-1",
    sourceBotId: "source-bot",
    sourceSpaceId: "space-a",
    lineageId: "line-1",
    version: 1,
    previousPackageId: null,
    contentHash: "hash-1",
    createdAt: "2026-11-05T00:00:00.000Z",
    revokedAt: null,
    snapshot: {
      schemaVersion: 1,
      title: "Spot playbook",
      sourceBotName: "Source",
      sourceSpaceName: "Business A",
      sourceWorkspaceKind: "trading",
      applicability: {
        conditions: ["Synthetic day-ahead market"],
        limitations: ["Not validated on real data"],
      },
      items: [
        {
          key: "memory-1",
          kind: "memory",
          title: "notes/forecast.md",
          content: "Forecast notes",
          description: null,
          files: null,
          sourceId: "m1",
          sourceRevision: "3",
          contentHash: "h-m",
        },
        {
          key: "skill-1",
          kind: "skill",
          title: "deviation-review",
          content: "# Deviation review",
          description: "Check deviations",
          files: {},
          sourceId: "s1",
          sourceRevision: "2",
          contentHash: "h-s",
        },
      ],
    },
    ...overrides,
  };
}

const defaultPlan = [
  { itemKey: "memory-1", action: "copy" as const, targetName: "notes/forecast.md" },
  { itemKey: "skill-1", action: "copy" as const, targetName: "deviation-review" },
];

function receipt(overrides: Partial<HandoffReceipt> = {}): HandoffReceipt {
  return {
    id: "import-1",
    packageId: "pkg-1",
    packageVersion: 1,
    packageHash: "hash-1",
    sourceSpaceId: "space-a",
    sourceBotId: "source-bot",
    sourceBotName: "Source",
    targetSpaceId: "space-b",
    targetBotId: "target-bot",
    targetBotName: "Target",
    createdAt: "2026-11-05T01:00:00.000Z",
    items: [
      {
        itemKey: "memory-1",
        kind: "memory",
        targetName: "notes/forecast-imported.md",
        targetId: "doc-1",
        initialRevision: 1,
        status: "copied",
      },
      {
        itemKey: "skill-1",
        kind: "skill",
        targetName: "deviation-review",
        targetId: "skill-copy-1",
        initialRevision: 1,
        status: "pending",
      },
    ],
    ...overrides,
  };
}

let client: QueryClient;
let view: { container: HTMLElement; cleanup: () => Promise<void> } | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  language.locale = "en";
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const fn of Object.values(api.experienceHandoff)) fn.mockReset();
  api.experienceHandoff.catalog.mockResolvedValue([
    {
      id: "m1",
      kind: "memory",
      sourceType: "bot_memory",
      title: "notes/forecast.md",
      revision: "3",
    },
    {
      id: "s1",
      kind: "skill",
      sourceType: "workspace_skill",
      title: "deviation-review",
      revision: "2",
    },
  ]);
  api.experienceHandoff.packages.mockResolvedValue({ items: [], nextCursor: null });
  api.experienceHandoff.history.mockResolvedValue({ items: [], nextCursor: null });
  api.experienceHandoff.skills.mockResolvedValue([]);
});

afterEach(async () => {
  await view?.cleanup();
  view = undefined;
});

async function settle() {
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

async function render(bot: Bot, mode: "export" | "import") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ExperienceHandoffPage bot={bot} mode={mode} onClose={() => undefined} />
      </QueryClientProvider>,
    ),
  );
  await settle();
  view = {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
  return container;
}

const $ = <T extends Element = HTMLElement>(selector: string) =>
  view!.container.querySelector<T>(selector);

function button(text: string, scope: ParentNode = view!.container) {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === text,
  );
}

async function click(el: HTMLElement | null | undefined) {
  await act(async () => el!.click());
  await settle();
}

async function type(el: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  const proto = Object.getPrototypeOf(el) as object;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function choose(el: HTMLSelectElement | null, value: string) {
  await act(async () => {
    el!.value = value;
    el!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

it("creates a fixed package from the chosen content and applicability", async () => {
  api.experienceHandoff.create.mockImplementation(async () => {
    api.experienceHandoff.packages.mockResolvedValue({ items: [pkg()], nextCursor: null });
    return pkg();
  });
  await render(source, "export");
  const text = view!.container.textContent;
  expect(text).toContain("This Bot's memory");
  expect(text).toContain("Workspace Skill");
  const create = () => button("Create package")!;
  expect(create().disabled).toBe(true);

  await type($('input[id$="-title"]'), "Spot playbook");
  await click($<HTMLInputElement>('input[type="checkbox"][aria-labelledby$="-m1"]'));
  await click($<HTMLInputElement>('input[type="checkbox"][aria-labelledby$="-s1"]'));
  // Applicability needs at least one condition before a package can be made.
  expect(create().disabled).toBe(true);
  await type($('input[aria-label="Condition 1"]'), "Synthetic day-ahead market");
  await click(button("Add", $("fieldset:nth-of-type(3)")!));
  await type($('input[aria-label="Limitation 1"]'), "Not validated on real data");
  await click(button("Add summary"));
  await type($('input[aria-label="Summary title"]'), "Lesson");
  await type($('textarea[aria-label="Summary"]'), "Forecast error dominated deviation.");
  expect(create().disabled).toBe(false);
  await click(create());

  const input = api.experienceHandoff.create.mock.calls[0]![0];
  expect(input).toEqual({
    requestId: expect.any(String),
    sourceBotId: "source-bot",
    title: "Spot playbook",
    applicability: {
      conditions: ["Synthetic day-ahead market"],
      limitations: ["Not validated on real data"],
    },
    summaries: [{ title: "Lesson", content: "Forecast error dominated deviation." }],
    memories: [{ id: "m1", revision: "3" }],
    skills: [{ id: "s1", revision: "2" }],
  });
  // The new fixed package opens with its source, applicability and items.
  const shown = $('[data-testid="handoff-package-pkg-1"]') as HTMLDetailsElement;
  expect(shown.open).toBe(true);
  expect(shown.textContent).toContain("Spot playbook · v1");
  expect(shown.textContent).toContain("Source · Business A · Trading");
  expect(shown.textContent).toContain("Synthetic day-ahead market");
  expect(shown.textContent).toContain("Not validated on real data");
  expect(shown.textContent).toContain("deviation-review · 2");
  expect(($('input[id$="-title"]') as HTMLInputElement).value).toBe("");
});

it("explains a refused package in the interface language and keeps the form", async () => {
  api.experienceHandoff.create.mockRejectedValue(
    Object.assign(new Error("Selected memory changed"), {
      code: "CONFLICT",
      data: { reason: "SOURCE_CHANGED" },
    }),
  );
  await render(source, "export");
  await type($('input[id$="-title"]'), "Spot playbook");
  await click($<HTMLInputElement>('input[type="checkbox"][aria-labelledby$="-m1"]'));
  await type($('input[aria-label="Condition 1"]'), "Synthetic market");
  await click(button("Create package"));
  expect($('[role="alert"]')?.textContent).toBe(
    "The selected content changed. Reload and choose again",
  );
  expect(($('input[id$="-title"]') as HTMLInputElement).value).toBe("Spot playbook");
});

it("offers the next version of a package and revokes an existing one", async () => {
  api.experienceHandoff.packages.mockResolvedValue({ items: [pkg()], nextCursor: null });
  api.experienceHandoff.revoke.mockResolvedValue(pkg({ revokedAt: "2026-11-05T02:00:00.000Z" }));
  await render(source, "export");
  const versions = $<HTMLSelectElement>('select[aria-label="Version"]')!;
  expect([...versions.options].map((o) => o.textContent)).toEqual([
    "New package",
    "Next version of Spot playbook v1",
  ]);
  await click(button("Revoke"));
  expect(api.experienceHandoff.revoke).toHaveBeenCalledWith({ packageId: "pkg-1" });
});

it("previews, resolves a name conflict, and confirms the exact previewed plan", async () => {
  api.experienceHandoff.packages.mockResolvedValue({ items: [pkg()], nextCursor: null });
  api.experienceHandoff.preview
    .mockResolvedValueOnce({
      package: pkg(),
      plan: defaultPlan,
      previewHash: "preview-1",
      conflicts: [{ itemKey: "memory-1", reason: "TARGET_EXISTS" }],
      alreadyImported: null,
    })
    .mockResolvedValueOnce({
      package: pkg(),
      plan: [{ ...defaultPlan[0]!, targetName: "notes/forecast-imported.md" }, defaultPlan[1]!],
      previewHash: "preview-2",
      conflicts: [],
      alreadyImported: null,
    });
  api.experienceHandoff.confirm.mockImplementation(async () => {
    api.experienceHandoff.history.mockResolvedValue({ items: [receipt()], nextCursor: null });
    api.experienceHandoff.skills.mockResolvedValue([
      {
        id: "skill-copy-1",
        botId: "target-bot",
        importId: "import-1",
        itemKey: "skill-1",
        name: "deviation-review",
        description: "Check deviations",
        content: "# Deviation review",
        files: {},
        revision: 1,
        enabledAt: null,
        blockedReason: null,
      },
    ]);
    return receipt();
  });
  await render(target, "import");
  await choose($('select[aria-label="Package"]'), "pkg-1");

  expect(api.experienceHandoff.preview).toHaveBeenCalledWith({
    packageId: "pkg-1",
    targetBotId: "target-bot",
  });
  const preview = $('[data-testid="handoff-preview"]')!;
  expect(preview.textContent).toContain("Source · Business A · Trading");
  expect(preview.textContent).toContain("Synthetic day-ahead market");
  expect(preview.textContent).toContain("Not validated on real data");
  const memoryRow = $('[data-testid="handoff-plan-memory-1"]')!;
  expect(memoryRow.textContent).toContain("This Bot already has something with this name");
  expect(button("Import")!.disabled).toBe(true);

  // Renaming makes the plan dirty: it must be previewed again before importing.
  await type(memoryRow.querySelector("input"), "notes/forecast-imported.md");
  expect(button("Import")!.disabled).toBe(true);
  expect(memoryRow.textContent).not.toContain("already has");
  await click(button("Preview again"));
  expect(api.experienceHandoff.preview).toHaveBeenLastCalledWith({
    packageId: "pkg-1",
    targetBotId: "target-bot",
    plan: [{ ...defaultPlan[0]!, targetName: "notes/forecast-imported.md" }, defaultPlan[1]!],
  });
  expect(button("Import")!.disabled).toBe(false);
  await click(button("Import"));
  expect(api.experienceHandoff.confirm).toHaveBeenCalledWith({
    packageId: "pkg-1",
    targetBotId: "target-bot",
    plan: [{ ...defaultPlan[0]!, targetName: "notes/forecast-imported.md" }, defaultPlan[1]!],
    previewHash: "preview-2",
  });

  // Imported memory and the Skill waiting to be enabled are shown apart.
  expect($('[data-testid="handoff-receipt"]')?.textContent).toContain(
    "notes/forecast-imported.md · Copied",
  );
  const experience = $('[data-testid="imported-experience"]')!;
  expect(experience.textContent).toContain("notes/forecast-imported.md · Source v1");
  expect(experience.textContent).not.toContain("deviation-review");
  const skills = $('[data-testid="imported-skills"]')!;
  expect(skills.textContent).toContain("deviation-review");
  expect(skills.textContent).toContain("Waiting to be enabled");
  expect(skills.textContent).not.toContain("forecast-imported");
});

it("shows an existing import instead of offering to import again", async () => {
  api.experienceHandoff.packages.mockResolvedValue({ items: [pkg()], nextCursor: null });
  api.experienceHandoff.preview.mockResolvedValue({
    package: pkg(),
    plan: defaultPlan,
    previewHash: "preview-1",
    conflicts: [],
    alreadyImported: receipt(),
  });
  await render(target, "import");
  await choose($('select[aria-label="Package"]'), "pkg-1");
  const preview = $('[data-testid="handoff-preview"]')!;
  expect(preview.textContent).toContain("Already imported to this Bot");
  expect(preview.textContent).toContain("deviation-review · Waiting to be enabled");
  expect(button("Import")).toBeUndefined();
});

it("hides revoked packages from the import choices", async () => {
  api.experienceHandoff.packages.mockResolvedValue({
    items: [pkg(), pkg({ id: "pkg-2", revokedAt: "2026-11-05T02:00:00.000Z" })],
    nextCursor: null,
  });
  await render(target, "import");
  const values = [...$<HTMLSelectElement>('select[aria-label="Package"]')!.options].map(
    (o) => o.value,
  );
  expect(values).toEqual(["", "pkg-1"]);
});

it("enables an imported Skill and traces history back to the imported package", async () => {
  api.experienceHandoff.history.mockResolvedValue({ items: [receipt()], nextCursor: null });
  api.experienceHandoff.skills.mockResolvedValue([
    {
      id: "skill-copy-1",
      botId: "target-bot",
      importId: "import-1",
      itemKey: "skill-1",
      name: "deviation-review",
      description: "Check deviations",
      content: "# Deviation review",
      files: {},
      revision: 1,
      enabledAt: null,
      blockedReason: null,
    },
  ]);
  api.experienceHandoff.updateSkill.mockResolvedValue({});
  api.experienceHandoff.importDetail.mockResolvedValue({ receipt: receipt(), package: pkg() });
  await render(target, "import");

  await click(
    $<HTMLInputElement>('[data-testid="imported-skill-deviation-review"] [role="switch"]'),
  );
  expect(api.experienceHandoff.updateSkill).toHaveBeenCalledWith({
    skillId: "skill-copy-1",
    expectedRevision: 1,
    enabled: true,
  });

  const entry = $<HTMLDetailsElement>('[data-testid="handoff-import-import-1"]')!;
  expect(entry.textContent).toContain("Source → Target · v1");
  expect(api.experienceHandoff.importDetail).not.toHaveBeenCalled();
  await act(async () => {
    entry.open = true;
    entry.dispatchEvent(new Event("toggle"));
  });
  await settle();
  expect(api.experienceHandoff.importDetail).toHaveBeenCalledWith(
    { importId: "import-1" },
    expect.anything(),
  );
  expect(entry.textContent).toContain("Synthetic day-ahead market");
  expect(entry.textContent).toContain("hash-1");
});

it("keeps the plan after a stale preview and lets it be previewed again at once", async () => {
  const renamed = [{ ...defaultPlan[0]!, targetName: "notes/mine.md" }, defaultPlan[1]!];
  api.experienceHandoff.packages.mockResolvedValue({ items: [pkg()], nextCursor: null });
  api.experienceHandoff.preview
    .mockResolvedValueOnce({
      package: pkg(),
      plan: defaultPlan,
      previewHash: "preview-1",
      conflicts: [],
      alreadyImported: null,
    })
    .mockResolvedValueOnce({
      package: pkg(),
      plan: renamed,
      previewHash: "preview-2",
      conflicts: [],
      alreadyImported: null,
    })
    .mockResolvedValueOnce({
      package: pkg(),
      plan: renamed,
      previewHash: "preview-3",
      conflicts: [],
      alreadyImported: null,
    });
  api.experienceHandoff.confirm
    .mockRejectedValueOnce(
      Object.assign(new Error("Preview is stale"), {
        code: "CONFLICT",
        data: { reason: "STALE_PREVIEW" },
      }),
    )
    .mockResolvedValueOnce(receipt());
  await render(target, "import");
  await choose($('select[aria-label="Package"]'), "pkg-1");
  const memoryName = () => $<HTMLInputElement>('[data-testid="handoff-plan-memory-1"] input')!;
  await type(memoryName(), "notes/mine.md");
  await click(button("Preview again"));
  await click(button("Import"));

  expect($('[role="alert"]')?.textContent).toBe(
    "The target changed. Preview again before importing",
  );
  // The plan stays as written; importing waits for a fresh preview, which is offered now.
  expect(memoryName().value).toBe("notes/mine.md");
  expect(button("Import")!.disabled).toBe(true);
  expect(button("Preview again")!.disabled).toBe(false);
  await click(button("Preview again"));
  expect(api.experienceHandoff.preview).toHaveBeenLastCalledWith({
    packageId: "pkg-1",
    targetBotId: "target-bot",
    plan: renamed,
  });
  expect(button("Import")!.disabled).toBe(false);
  await click(button("Import"));
  expect(api.experienceHandoff.confirm).toHaveBeenLastCalledWith({
    packageId: "pkg-1",
    targetBotId: "target-bot",
    plan: renamed,
    previewHash: "preview-3",
  });
});

it("rewords a shown error when the interface language changes", async () => {
  api.experienceHandoff.create.mockRejectedValue(
    Object.assign(new Error("Selected memory changed"), {
      code: "CONFLICT",
      data: { reason: "SOURCE_CHANGED" },
    }),
  );
  await render(source, "export");
  await type($('input[id$="-title"]'), "Spot playbook");
  await click($<HTMLInputElement>('input[type="checkbox"][aria-labelledby$="-m1"]'));
  await type($('input[aria-label="Condition 1"]'), "Synthetic market");
  await click(button("Create package"));
  expect($('[role="alert"]')?.textContent).toBe(
    "The selected content changed. Reload and choose again",
  );
  await switchLanguage("zh-CN");
  expect($('[role="alert"]')?.textContent).toBe(
    "[zh-CN] The selected content changed. Reload and choose again",
  );
  await switchLanguage("en");
  expect($('[role="alert"]')?.textContent).toBe(
    "The selected content changed. Reload and choose again",
  );
});

it("tells same-named Bot and shared memories apart before they are ticked", async () => {
  api.experienceHandoff.catalog.mockResolvedValue([
    { id: "bot-mem", kind: "memory", sourceType: "bot_memory", title: "MEMORY.md", revision: "3" },
    {
      id: "shared-mem",
      kind: "memory",
      sourceType: "shared_memory",
      title: "MEMORY.md",
      revision: "5",
    },
    {
      id: "copy",
      kind: "skill",
      sourceType: "imported_skill",
      title: "deviation-review",
      revision: "1",
    },
  ]);
  api.experienceHandoff.create.mockResolvedValue(pkg());
  await render(source, "export");
  // Each checkbox is named by its source and title, read from the elements it points at.
  const names = [
    ...view!.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ].map((box) =>
    box
      .getAttribute("aria-labelledby")!
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent)
      .join(" "),
  );
  expect(names).toEqual([
    "This Bot's memory MEMORY.md",
    "Shared memory MEMORY.md",
    "Imported Skill deviation-review",
  ]);

  await type($('input[id$="-title"]'), "Shared notes");
  await click($<HTMLInputElement>('input[type="checkbox"][aria-labelledby$="-shared-mem"]'));
  await type($('input[aria-label="Condition 1"]'), "Synthetic market");
  await click(button("Create package"));
  expect(api.experienceHandoff.create.mock.calls[0]![0].memories).toEqual([
    { id: "shared-mem", revision: "5" },
  ]);
});

it("uses generic catalog labels when an older server omits source types", async () => {
  api.experienceHandoff.catalog.mockResolvedValue([
    { id: "legacy-memory", kind: "memory", title: "MEMORY.md", revision: "1" },
    { id: "legacy-skill", kind: "skill", title: "legacy-skill", revision: "1" },
  ]);
  await render(source, "export");
  const names = [
    ...view!.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ].map((box) =>
    box
      .getAttribute("aria-labelledby")!
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent)
      .join(" "),
  );
  expect(names).toEqual(["Memory MEMORY.md", "Skill legacy-skill"]);
});
