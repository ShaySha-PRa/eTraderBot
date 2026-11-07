// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  spaces: { list: vi.fn() },
  availability: { set: vi.fn() },
}));
vi.mock("../../lib/rpc", () => ({
  rpc: api,
  rpcForSpace: () => api,
  createSpaceRpc: () => api,
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => ({
  Plural: () => null,
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    DropdownMenu: Container,
    DropdownMenuContent: Container,
    DropdownMenuSeparator: () => null,
    DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    DropdownMenuCheckboxItem: ({
      children,
      checked,
      onCheckedChange,
    }: {
      children?: ReactNode;
      checked: boolean;
      onCheckedChange: (checked: boolean) => void;
    }) => (
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={checked}
        onClick={() => onCheckedChange(true)}
      >
        {children}
      </button>
    ),
  };
});

import { AvailabilityControl } from "./space-availability";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function mounted(kind: "mcpServer" | "skill", refusal: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.spaces.list.mockResolvedValue({
    spaces: [
      { id: "space-a", name: "Business A", isDefault: false },
      { id: "space-b", name: "Business B", isDefault: false },
    ],
  });
  api.availability.set.mockRejectedValue(Object.assign(new Error(refusal), { code: "CONFLICT" }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <AvailabilityControl
          kind={kind}
          id="item-1"
          availability={{ allSpaces: false, spaceIds: ["space-a"] }}
          onChanged={() => undefined}
        />
      </QueryClientProvider>,
    ),
  );
  await act(async () => vi.waitFor(() => expect(container.textContent).toContain("Business B")));
  const item = [...container.querySelectorAll('[role="menuitemcheckbox"]')].find(
    (el) => el.textContent === "Business B",
  ) as HTMLButtonElement;
  await act(async () => item.click());
  await act(async () =>
    vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull()),
  );
  return container.querySelector('[role="alert"]')!.textContent;
}

it("says an MCP connection's identifier is already in use in another business", async () => {
  expect(
    await mounted(
      "mcpServer",
      "An MCP server with that identifier already exists in one of these spaces.",
    ),
  ).toBe(
    "A connection already uses this identifier. Choose another name or use the existing connection.",
  );
});

it("keeps a skill's own conflict message", async () => {
  expect(
    await mounted("skill", "A skill with that name already exists in one of these spaces."),
  ).toBe("A skill with that name already exists in one of these spaces.");
});
