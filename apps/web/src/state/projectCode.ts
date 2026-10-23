import { createProjectCodeAtoms } from "@t3tools/client-runtime/projectCode";
import { connectionAtomRuntime } from "../connection/runtime";

export const projectCode = createProjectCodeAtoms(connectionAtomRuntime);
