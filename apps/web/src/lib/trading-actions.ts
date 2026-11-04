import { useLingui } from "@lingui/react/macro";
import { isIdentityConfirmationRequired } from "@rakazo/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useIdentityConfirmation } from "../components/ConfirmIdentityDialog";
import { useSpaceQueries } from "./query";
import { rpc, rpcForSpace, selectedSpaceId } from "./rpc";
import { useBoundSpaceId } from "./space-rpc";
import { errorText } from "./user-error";

export function useTradingActions() {
  const { t } = useLingui();
  const scopeId = useBoundSpaceId() ?? selectedSpaceId();
  const api = scopeId ? rpcForSpace(scopeId) : rpc;
  const queries = useSpaceQueries();
  const cache = useQueryClient();
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false);
  async function act(action: () => Promise<unknown>, human = false) {
    if (active.current) return;
    active.current = true;
    setPending(true);
    setError("");
    try {
      await (human ? withIdentityConfirmation(action) : action());
      await cache.invalidateQueries({ queryKey: queries.trading.key() });
    } catch (cause) {
      if (!isIdentityConfirmationRequired(cause)) setError(errorText(cause, t`Could not continue`));
      return { error: cause };
    } finally {
      active.current = false;
      setPending(false);
    }
  }
  return { api, act, pending, error, identityDialog };
}
