import { ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { goalNowItem } from "./ThreadActivityBanners";

it.each([false, true])(
  "queues goal resume when the client reports working=%s",
  async (isWorking) => {
    const send = vi.fn(async () => undefined);
    const item = goalNowItem({
      threadId: ThreadId.make("goal-thread"),
      goal: { objective: "Finish the tests", status: "blocked" },
      isWorking,
      onSendCommand: send,
    });
    await using screen = await render(<>{item.actions}</>);
    await screen
      .getByRole("button", { name: isWorking ? "Resume after turn" : "Resume", exact: true })
      .click();
    expect(send).toHaveBeenCalledWith("/goal resume", "Failed to resume goal.", "queue");
  },
);
