import { createProjectKnowledgeAtoms } from "@t3tools/client-runtime/projectKnowledge";
import { connectionAtomRuntime } from "../connection/runtime";

export const projectKnowledge = createProjectKnowledgeAtoms(connectionAtomRuntime);
