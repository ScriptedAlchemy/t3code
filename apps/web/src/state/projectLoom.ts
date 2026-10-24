import { createProjectLoomAtoms } from "@t3tools/client-runtime/projectLoom";
import { connectionAtomRuntime } from "../connection/runtime";

export const projectLoom = createProjectLoomAtoms(connectionAtomRuntime);
