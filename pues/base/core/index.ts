export { defaultCoreName, defaultRoot, resolveCoreName } from "./defaultRoot";
export {
  isByLegendum,
  isSelfHosted,
  LOCAL_USER_EMAIL,
  setByLegendum,
} from "./mode";
export {
  Pues,
  type PuesProps,
  type PuesUser,
  usePuesFetch,
  usePuesUser,
} from "./Pues";
export { puesAppMeta } from "./puesAppMeta.generated";
export {
  bytesToUlid,
  isUlid,
  ULID_RE,
  ulid,
  ulidPattern,
  ulidTime,
  ulidToBytes,
} from "./ulid";
// Outside-React fetch wrapper. `<Pues>` uses this internally to wrap the
// supplied/global fetch with the 401-handler; consumers reach for it
// directly at module scope (CLI scripts, top-level helpers, service
// workers) where a React hook is not available. Same wrapper, same
// subscription chain, no monkey-patch.
export { wrapFetchWithUnauthorized as puesAuthedFetch } from "./unauthorizedHandler";
export { useOnlineStatus } from "./useOnlineStatus";
export { usePageTitle } from "./usePageTitle";
