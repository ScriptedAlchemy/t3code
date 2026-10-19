import { expect, it } from "@effect/vitest";

import { BUILT_IN_DRIVERS } from "./provider/builtInDrivers.ts";
import { providerSettingsFieldPolicy } from "./settingsSecrets.ts";

it("classifies the settings fields of every built-in driver", () => {
  for (const driver of BUILT_IN_DRIVERS) {
    expect(providerSettingsFieldPolicy(driver.driverKind), driver.driverKind).toBeDefined();
  }
});
