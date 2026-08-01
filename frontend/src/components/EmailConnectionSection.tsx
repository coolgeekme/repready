import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import { api } from "@/src/lib/api";
import { colors, radii, spacing } from "@/src/theme";

export type EmailProvider = "gmail" | "outlook";

type EmailAccount = {
  id: string;
  status?: string;
  display_name?: string;
  created_at?: string;
};

type ProviderStatus = {
  connected?: boolean;
  configured?: boolean;
};

const PROVIDERS: {
  key: EmailProvider;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  desc: string;
}[] = [
  {
    key: "gmail",
    label: "Gmail",
    icon: "logo-google",
    color: "#EA4335",
    desc: "Send cold emails from your Gmail account",
  },
  {
    key: "outlook",
    label: "Outlook",
    icon: "logo-microsoft",
    color: "#0078D4",
    desc: "Send cold emails from your Outlook/Microsoft 365 account",
  },
];

type Props = {
  onToast?: (msg: string, ms?: number) => void;
};

export default function EmailConnectionSection({ onToast }: Props) {
  const [statuses, setStatuses] = useState<Record<string, ProviderStatus>>({});
  const [accounts, setAccounts] = useState<Record<string, EmailAccount[]>>({});
  const [connecting, setConnecting] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const toast = useCallback(
    (m: string, ms = 1600) => {
      if (onToast) onToast(m, ms);
    },
    [onToast],
  );

  const refresh = useCallback(async () => {
    const next: Record<string, EmailAccount[]> = {};
    const stats: Record<string, ProviderStatus> = {};
    await Promise.all(
      PROVIDERS.map(async (p) => {
        try {
          const r = await api.emailAccounts(p.key);
          next[p.key] = r.accounts || [];
          stats[p.key] = {
            connected: (r.accounts || []).some(
              (a: EmailAccount) => a.status === "ACTIVE" || !a.status,
            ),
            configured: r.configured !== false,
          };
        } catch (e: any) {
          next[p.key] = [];
          stats[p.key] = { connected: false, configured: false };
        }
      }),
    );
    setAccounts(next);
    setStatuses(stats);
    setLoaded(true);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const connectAccount = async (provider: EmailProvider) => {
    setConnecting(provider);
    try {
      const res = await api.emailConnect(provider);
      if (res?.already_connected) {
        toast(`${provider} already connected`);
      } else if (res?.redirect_url) {
        await WebBrowser.openBrowserAsync(res.redirect_url);
      }
      await refresh();
    } catch (e: any) {
      const msg = (e?.message || "").includes("503")
        ? "not configured"
        : "connect failed";
      toast(`${provider} ${msg}`);
    } finally {
      setConnecting(null);
    }
  };

  const deleteAccount = async (provider: EmailProvider, accountId: string) => {
    setBusy(`delete-${accountId}`);
    try {
      await api.emailDisconnect(provider);
      await refresh();
      toast(`${provider} account removed`);
    } catch (e: any) {
      toast("Remove failed");
    } finally {
      setBusy(null);
    }
  };

  if (!loaded) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator color={colors.primary} size="small" />
        <Text style={styles.loadingText}>Checking email accounts…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.sectionHeader}>
        <Ionicons name="mail-outline" size={16} color={colors.primary} />
        <Text style={styles.sectionHeaderText}>Email accounts</Text>
      </View>
      <Text style={styles.helper}>
        Connect Gmail or Outlook to send cold emails directly from the app.
        You can add multiple accounts per provider.
      </Text>

      {PROVIDERS.map((p) => {
        const accts = accounts[p.key] || [];
        const connected = statuses[p.key]?.connected || false;
        const configured = statuses[p.key]?.configured !== false;
        const activeAccounts = accts.filter(
          (a) => a.status === "ACTIVE" || !a.status,
        );

        return (
          <View key={p.key} style={styles.providerBlock}>
            <View style={styles.providerHeader}>
              <Ionicons name={p.icon} size={22} color={p.color} />
              <View style={{ flex: 1 }}>
                <Text style={styles.providerTitle}>{p.label}</Text>
                <Text style={styles.providerSubtitle}>
                  {connected
                    ? `${activeAccounts.length} account${activeAccounts.length !== 1 ? "s" : ""} connected`
                    : configured
                      ? "Not connected"
                      : "Not configured"}
                </Text>
              </View>
              {/* "+ Add" button always visible when configured */}
              {configured && (
                <TouchableOpacity
                  testID={`email-connect-${p.key}`}
                  style={styles.addBtn}
                  onPress={() => connectAccount(p.key)}
                  disabled={connecting === p.key}
                >
                  {connecting === p.key ? (
                    <ActivityIndicator color={p.color} size="small" />
                  ) : (
                    <Ionicons name="add-circle-outline" size={20} color={p.color} />
                  )}
                </TouchableOpacity>
              )}
            </View>

            {/* Individual account rows */}
            {activeAccounts.length > 0 && (
              <View style={styles.accountsList}>
                {activeAccounts.map((a) => (
                  <View key={a.id} style={styles.accountRow}>
                    <View style={[styles.accountDot, { backgroundColor: p.color }]} />
                    <Text style={styles.accountName} numberOfLines={1}>
                      {a.display_name || `…${a.id.slice(-8)}`}
                    </Text>
                    <Text style={styles.accountStatus}>ACTIVE</Text>
                    <TouchableOpacity
                      testID={`email-delete-${a.id}`}
                      style={styles.accountDelBtn}
                      onPress={() => deleteAccount(p.key, a.id)}
                      disabled={busy === `delete-${a.id}`}
                      hitSlop={6}
                    >
                      {busy === `delete-${a.id}` ? (
                        <ActivityIndicator color={colors.error} size="small" />
                      ) : (
                        <Ionicons name="trash-outline" size={14} color={colors.error} />
                      )}
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}

            {!connected && configured && (
              <TouchableOpacity
                testID={`email-connect-initial-${p.key}`}
                style={[styles.connectInitialBtn, { borderColor: p.color }]}
                onPress={() => connectAccount(p.key)}
                disabled={connecting === p.key}
              >
                {connecting === p.key ? (
                  <ActivityIndicator color={p.color} size="small" />
                ) : (
                  <>
                    <Ionicons name={p.icon} size={18} color={p.color} />
                    <Text style={[styles.connectInitialText, { color: p.color }]}>
                      Connect {p.label}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: spacing.lg },
  loadingWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 12,
    marginTop: spacing.lg,
  },
  loadingText: { color: colors.textMuted, fontSize: 13 },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sectionHeaderText: {
    fontSize: 18,
    fontWeight: "800",
    color: colors.text,
    letterSpacing: -0.4,
  },
  helper: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 8,
    marginBottom: 4,
    lineHeight: 19,
  },
  providerBlock: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: "#fff",
    marginTop: 10,
    overflow: "hidden",
  },
  providerHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: spacing.md,
  },
  providerTitle: { fontWeight: "800", color: colors.text, fontSize: 15 },
  providerSubtitle: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  addBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  accountsList: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  accountRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  accountDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  accountName: {
    flex: 1,
    color: colors.text,
    fontWeight: "600",
    fontSize: 13,
  },
  accountStatus: {
    color: "#16a34a",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  accountDelBtn: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  connectInitialBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    paddingVertical: 10,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderStyle: "dashed",
  },
  connectInitialText: {
    fontWeight: "700",
    fontSize: 13,
  },
});
