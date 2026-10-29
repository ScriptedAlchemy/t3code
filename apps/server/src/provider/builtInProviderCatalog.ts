import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  TextGenerationOperation,
} from "@t3tools/contracts";
import type * as Stream from "effect/Stream";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";

export type ProviderSnapshotSource = {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly textGenerationOperations: ReadonlyArray<TextGenerationOperation>;
  readonly getSnapshot: ManagedServerProvider["getSnapshot"];
  readonly refresh: ManagedServerProvider["refresh"];
  readonly streamChanges: Stream.Stream<ServerProvider>;
};
