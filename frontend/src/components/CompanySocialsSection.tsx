import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import { api } from "@/src/lib/api";
import { colors, radii, spacing } from "@/src/theme";

export type SocialPlatform = "linkedin" | "facebook" | "instagram";

type SocialAccount = { id: string; status?: string; display_name?: string; created_at?: string };
type PlatformStatus = { connected?: boolean; configured?: boolean };

const SOCIALS: { key: SocialPlatform; label: string; icon: keyof typeof Ionicons.glyphMap; color: string }[] = [
  { key: "linkedin", label: "LinkedIn", icon: "logo-linkedin", color: "#0A66C2" },
  { key: "facebook", label: "Facebook", icon: "logo-facebook", color: "#1877F2" },
  { key: "instagram", label: "Instagram", icon: "logo-instagram", color: "#E1306C" },
];

type Props = {
  companyId: string;
  companyName: string;
  linkedAccounts?: Record<string, string | null | undefined>;
  onChange?: () => void; // called after a link/unlink/delete/connect — parent should refresh company state
  onToast?: (msg: string, ms?: number) => void;
};

/**
 * Per-company social account manager. Shows each platform with:
 *  - a list of all connected Composio accounts (display_name)
 *  - a radio button to pick which account this company posts from
 *  - a trash icon to delete each account (user-level removal)
 *  - a "+ Connect" / "+ Add" button to start a new Composio OAuth handshake
 */
export default function CompanySocialsSection({ companyId, companyName, linkedAccounts, onChange, onToast }: Props) {
  const [statuses, setStatuses] = useState<Record<string, PlatformStatus>>({});
  const [accounts, setAccounts] = useState<Record<string, SocialAccount[]>>({});
  const [connecting, setConnecting] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const toast = useCallback((m: string, ms = 1600) => {
    if (onToast) onToast(m, ms);
  }, [onToast]);

  const refresh = useCallback(async () => {
    const next: Record<string, SocialAccount[]> = {};
    const stats: Record<string, PlatformStatus> = {};
    await Promise.all(SOCIALS.map(async (s) => {
      try {
        const r = await api.socialAccounts(s.key);
        next[s.key] = r.accounts || [];
        stats[s.key] = { connected: (r.accounts || []).some((a: SocialAccount) => a.status === "ACTIVE" || !a.status), configured: r.configured !== false };
      } catch (e: any) {
        next[s.key] = [];
        stats[s.key] = { connected: false, configured: false };
      }
    }));
    setAccounts(next);
    setStatuses(stats);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const connectAccount = async (platform: SocialPlatform) => {
    setConnecting(platform);
    try {
      const res = await api.socialConnect(platform);
      if (res?.already_connected) {
        toast(`${platform} already connected`);
      } else if (res?.redirect_url) {
        await WebBrowser.openBrowserAsync(res.redirect_url);
      }
      await refresh();
      if (onChange) onChange();
    } catch (e: any) {
      const msg = (e?.message || "").includes("503") ? "not configured" : "connect failed";
      toast(`${platform} ${msg}`);
    } finally {
      setConnecting(null);
    }
  };

  const deleteAccount = async (platform: SocialPlatform, accountId: string) => {
    setBusy(`delete-${platform}-${accountId}`);
    try {
      await api.deleteSocialAccount(platform, accountId);
      await refresh();
      if (onChange) onChange();
      toast("Account removed");
    } catch (e: any) {
      toast("Remove failed");
    } finally {
      setBusy(null);
    }
  };

  const linkAccount = async (platform: SocialPlatform, accountId: string | null) => {
    setBusy(`link-${platform}-${accountId || "none"}`);
    try {
      await api.linkAccountToCompany(companyId, platform, accountId);
      if (onChange) onChange();
      toast(accountId ? `${platform} linked` : `${platform} unlinked`);
    } catch (e: any) {
      toast("Link failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <View>
      <Text style={styles.helper}>
        Choose which account “{companyName}” posts from. Add as many as you need per network.
      </Text>

      {SOCIALS.map((s) => {
        const isConnecting = connecting === s.key;
        const platformAccounts = (accounts[s.key] || []).filter((a) => a.status === "ACTIVE" || !a.status);
        const linkedId = linkedAccounts?.[s.key] || null;
        const notConfigured = statuses[s.key]?.configured === false;
        return (
          <View key={s.key} style={styles.platformBlock}>
            <View style={styles.platformHeader}>
              <Ionicons name={s.icon} size={22} color={s.color} />
              <View style={{ flex: 1 }}>
                <Text style={styles.platformTitle}>{s.label}</Text>
                <Text style={styles.platformSubtitle}>
                  {notConfigured
                    ? "Not configured in backend"
                    : platformAccounts.length === 0
                    ? "No accounts connected yet"
                    : `${platformAccounts.length} account${platformAccounts.length === 1 ? "" : "s"} connected`}
                </Text>
              </View>
              <TouchableOpacity
                testID={`company-${s.key}-connect`}
                style={[styles.smallBtn, { backgroundColor: s.color }, notConfigured && { opacity: 0.5 }]}
                onPress={() => connectAccount(s.key)}
                disabled={isConnecting || notConfigured}
              >
                {isConnecting ? <ActivityIndicator color="#fff" size="small" /> : (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                    <Ionicons name="add" size={14} color="#fff" />
                    <Text style={styles.smallBtnText}>{platformAccounts.length === 0 ? "Connect" : "Add"}</Text>
                  </View>
                )}
              </TouchableOpacity>
            </View>

            {platformAccounts.length > 0 && (
              <View style={styles.accountsList}>
                {platformAccounts.map((a) => {
                  const isLinked = linkedId === a.id;
                  const deleting = busy === `delete-${s.key}-${a.id}`;
                  return (
                    <View key={a.id} style={styles.accountRow}>
                      <TouchableOpacity
                        testID={`company-account-link-${s.key}-${a.id}`}
                        style={styles.radioWrap}
                        onPress={() => linkAccount(s.key, isLinked ? null : a.id)}
                        activeOpacity={0.7}
                      >
                        <View style={[styles.radio, isLinked && styles.radioActive]}>
                          {isLinked && <View style={styles.radioDot} />}
                        </View>
                      </TouchableOpacity>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.accountName} numberOfLines={1}>
                          {a.display_name || `Account …${a.id.slice(-6)}`}
                        </Text>
                        <Text style={styles.accountMeta}>
                          {isLinked ? `Used by ${companyName}` : (a.status || "Connected")}
                        </Text>
                      </View>
                      <TouchableOpacity
                        testID={`company-account-delete-${s.key}-${a.id}`}
                        style={styles.accountDelBtn}
                        onPress={() => deleteAccount(s.key, a.id)}
                        disabled={deleting}
                        hitSlop={6}
                      >
                        {deleting ? <ActivityIndicator color={colors.error} size="small" /> : (
                          <Ionicons name="trash-outline" size={16} color={colors.error} />
                        )}
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  helper: { color: colors.textMuted, fontSize: 13, marginBottom: 8 },
  platformBlock: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, backgroundColor: "#fff", marginTop: 10, overflow: "hidden" },
  platformHeader: { flexDirection: "row", alignItems: "center", gap: 12, padding: spacing.md },
  platformTitle: { fontWeight: "800", color: colors.text, fontSize: 15 },
  platformSubtitle: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  accountsList: { borderTopWidth: 1, borderTopColor: colors.border },
  accountRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: spacing.md, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  radioWrap: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.border, alignItems: "center", justifyContent: "center", backgroundColor: "#fff" },
  radioActive: { borderColor: colors.primary },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary },
  accountName: { color: colors.text, fontWeight: "700", fontSize: 14 },
  accountMeta: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  accountDelBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: radii.sm, borderWidth: 1, borderColor: colors.border },
  smallBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: radii.sm },
  smallBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },
});
