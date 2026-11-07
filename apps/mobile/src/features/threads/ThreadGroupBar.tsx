import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isGroupActive } from "@t3tools/client-runtime/state/thread-group";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { useEnvironmentServerConfig } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

export function ThreadGroupBar({ thread }: { readonly thread: EnvironmentThreadShell }) {
  const { environmentId, group } = thread;
  const navigation = useNavigation();
  const config = useEnvironmentServerConfig(environmentId);
  const canInvite = useAtomValue(
    orchestrationEnvironment.inviteToGroup.permissionAtom(environmentId),
  );
  const canRemove = useAtomValue(
    orchestrationEnvironment.removeFromGroup.permissionAtom(environmentId),
  );
  const canEnd = useAtomValue(orchestrationEnvironment.endGroup.permissionAtom(environmentId));
  const inviteAvailable =
    canInvite &&
    config?.settings.groupConversationsEnabled === true &&
    thread.lineage.sideChat !== true &&
    thread.lineage.relationshipToParent !== "subagent";
  const remove = useAtomCommand(orchestrationEnvironment.removeFromGroup);
  const end = useAtomCommand(orchestrationEnvironment.endGroup);
  const openWork = useOpenLinkedThread();
  const active = isGroupActive(group);
  if (!active && !inviteAvailable) return null;

  return (
    <View className="gap-1 px-4 pb-2">
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View className="flex-row items-center gap-2">
          {active ? (
            <>
              <Text
                accessibilityLabel={`${group.primary.label}, primary`}
                className="text-xs font-t3-medium text-foreground"
              >
                ★ {group.primary.label}
              </Text>
              {group.seats
                .filter((seat) => seat.status === "seated")
                .map((seat) => (
                  <Menu
                    key={seat.threadId}
                    actions={[
                      { id: "work", title: "Open work", image: "arrow.up.right" },
                      {
                        id: "remove",
                        title: "Remove",
                        image: "person.fill.xmark",
                        attributes: { destructive: true, disabled: !canRemove },
                      },
                    ]}
                    onPressAction={({ nativeEvent }) => {
                      if (nativeEvent.event === "work")
                        openWork({ environmentId, threadId: seat.threadId });
                      if (nativeEvent.event === "remove")
                        void remove({
                          environmentId,
                          input: { threadId: thread.id, seatThreadId: seat.threadId },
                        });
                    }}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${seat.label}, group member actions`}
                      className="rounded-full bg-subtle px-3 py-2"
                    >
                      <Text className="text-xs text-foreground">{seat.label}</Text>
                    </Pressable>
                  </Menu>
                ))}
            </>
          ) : null}
          {inviteAvailable ? (
            <Button
              label="Invite a model"
              size="compact"
              tone="text"
              onPress={() =>
                navigation.navigate("ThreadGroupInvite", { environmentId, threadId: thread.id })
              }
            />
          ) : null}
          {active ? (
            <Button
              label="End group"
              accessibilityLabel={`End group and continue with ${group.primary.label}`}
              size="compact"
              tone="text"
              disabled={!canEnd}
              onPress={() => void end({ environmentId, input: { threadId: thread.id } })}
            />
          ) : null}
        </View>
      </ScrollView>
      {active && group.discussion === null && group.closedBecause === "budget" ? (
        <Text accessibilityRole="text" className="text-xs text-foreground-muted">
          A member has unanswered replies. Any message continues.
        </Text>
      ) : null}
    </View>
  );
}
