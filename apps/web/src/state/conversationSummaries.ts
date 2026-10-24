import { createConversationSummariesAtoms } from "@t3tools/client-runtime/conversationSummaries";
import { connectionAtomRuntime } from "../connection/runtime";

export const conversationSummaries = createConversationSummariesAtoms(connectionAtomRuntime);
