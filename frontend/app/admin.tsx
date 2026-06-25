import { useCallback, useEffect, useState } from "react";
import { View, Text, TextInput, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Ionicons } from "@expo/vector-icons";
import { router, Stack } from "expo-router";
import { api } from "@/src/lib/api";
import { colors, fonts, radii, spacing } from "@/src/theme";

type AdminUser = {
  user_id: string;
  email?: string;
  display_name?: string;
  is_admin?: boolean;
  entitlement: {
    is_admin: boolean;
    tier: string;
    source: string;
    active: boolean;
    expires_at?: string | null;
    note?: string | null;
  };
};

const DURATION_OPTIONS = [
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
  { key: "90d", label: "90 days", days: 90 },
  { key: "1y", label: "1 year", days: 365 },
  { key: "lifetime", label: "Lifetime (100y)", days: 36500 },
];

export default function Admin() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [filter, setFilter] = useState("");
  const [grantEmail, setGrantEmail] = useState("");
  const [grantDuration, setGrantDuration] = useState<string>("1y");
  const [grantNote, setGrantNote] = useState("");
  const [grantTier, setGrantTier] = useState<"pro" | "enterprise">("pro");
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (m: string, ms = 2000) => {
    setToast(m);
    setTimeout(() => setToast(null), ms);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.adminListUsers();
      setUsers(res.items || []);
      setDenied(false);
    } catch (e: any) {
      if ((e?.message || "").includes("403")) {
        setDenied(true);
      } else {
        showToast(`Load failed: ${(e?.message || "").slice(0, 80)}`);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const grant = async (email: string) => {
    if (!email.trim()) {
      showToast("Email required");
      return;
    }
    setBusy(`grant-${email}`);
    try {
      const opt = DURATION_OPTIONS.find((o) => o.key === grantDuration) || DURATION_OPTIONS[3];
      await api.adminGrantComp({
        email: email.trim(),
        duration_days: opt.days,
        note: grantNote.trim() || undefined,
        tier: grantTier,
      });
      showToast(`✓ Granted ${opt.label} ${grantTier} to ${email}`);
      setGrantEmail("");
      setGrantNote("");
      load();
    } catch (e: any) {
      showToast(`Grant failed: ${(e?.message || "").slice(0, 100)}`, 4000);
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (email?: string) => {
    if (!email) return;
    setBusy(`revoke-${email}`);
    try {
      await api.adminRevokeComp(email);
      showToast(`Revoked ${email}`);
      load();
    } catch (e: any) {
      showToast(`Revoke failed: ${(e?.message || "").slice(0, 80)}`);
    } finally {
      setBusy(null);
    }
  };

  const formatExp = (iso?: string | null) => {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
    } catch { return iso; }
  };

  const filteredUsers = users.filter((u) => {
    if (!filter.trim()) return true;
    const f = filter.toLowerCase();
    return (u.email || "").toLowerCase().includes(f) || (u.display_name || "").toLowerCase().includes(f);
  });

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      </SafeAreaView>
    );
  }

  if (denied) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.header}>
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()} hitSlop={8}>
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.title}>Admin</Text>
        </View>
        <View style={styles.center}>
          <Ionicons name="lock-closed-outline" size={48} color={colors.error} />
          <Text style={styles.deniedTitle}>Admin only</Text>
          <Text style={styles.deniedDesc}>Your account isn&apos;t on the admin list. Add your email to backend ADMIN_EMAILS env to get access.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity testID="admin-back" style={styles.iconBtn} onPress={() => router.back()} hitSlop={8}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Admin · Comps</Text>
          <Text style={styles.subtitle}>{users.length} user{users.length === 1 ? "" : "s"}</Text>
        </View>
        <TouchableOpacity style={styles.iconBtn} onPress={load}>
          <Ionicons name="refresh" size={20} color={colors.text} />
        </TouchableOpacity>
      </View>

      <KeyboardAwareScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {/* Grant section */}
        <View style={styles.grantCard}>
          <Text style={styles.cardTitle}>Grant comp</Text>
          <Text style={styles.cardDesc}>Give a friend/family free Pro access. They must have signed up at least once.</Text>

          <Text style={styles.fieldLabel}>Email</Text>
          <TextInput
            testID="grant-email-input"
            style={styles.input}
            value={grantEmail}
            onChangeText={setGrantEmail}
            placeholder="friend@example.com"
            placeholderTextColor={colors.textSubtle}
            autoCapitalize="none"
            keyboardType="email-address"
          />

          <Text style={styles.fieldLabel}>Duration</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
            {DURATION_OPTIONS.map((o) => (
              <TouchableOpacity
                key={o.key}
                testID={`grant-dur-${o.key}`}
                onPress={() => setGrantDuration(o.key)}
                style={[styles.chip, grantDuration === o.key && styles.chipActive]}
              >
                <Text style={[styles.chipText, grantDuration === o.key && styles.chipTextActive]}>{o.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          <Text style={styles.fieldLabel}>Tier</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {(["pro", "enterprise"] as const).map((t) => (
              <TouchableOpacity
                key={t}
                testID={`grant-tier-${t}`}
                onPress={() => setGrantTier(t)}
                style={[styles.chip, grantTier === t && styles.chipActive]}
              >
                <Text style={[styles.chipText, grantTier === t && styles.chipTextActive]}>{t === "pro" ? "Pro" : "Enterprise"}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.fieldLabel}>Note (optional)</Text>
          <TextInput
            testID="grant-note-input"
            style={styles.input}
            value={grantNote}
            onChangeText={setGrantNote}
            placeholder="e.g. Family, Beta tester"
            placeholderTextColor={colors.textSubtle}
          />

          <TouchableOpacity
            testID="grant-btn"
            style={[styles.grantBtn, (!grantEmail.trim() || busy === `grant-${grantEmail}`) && { opacity: 0.5 }]}
            onPress={() => grant(grantEmail)}
            disabled={!grantEmail.trim() || busy === `grant-${grantEmail}`}
          >
            {busy === `grant-${grantEmail}` ? <ActivityIndicator color="#fff" /> : (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Ionicons name="gift" size={16} color="#fff" />
                <Text style={styles.grantBtnText}>Grant comp</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>

        {/* Users list */}
        <View style={styles.sectionHeader}>
          <Ionicons name="people-outline" size={18} color={colors.primary} />
          <Text style={styles.sectionHeaderText}>All users</Text>
        </View>
        <TextInput
          testID="admin-filter"
          style={styles.input}
          value={filter}
          onChangeText={setFilter}
          placeholder="Search by email or name…"
          placeholderTextColor={colors.textSubtle}
          autoCapitalize="none"
        />

        {filteredUsers.map((u) => {
          const e = u.entitlement;
          const active = e.active;
          const isComp = e.source === "admin_comp";
          return (
            <View key={u.user_id} style={styles.userCard} testID={`user-card-${u.email || u.user_id}`}>
              <View style={{ flex: 1 }}>
                <View style={styles.userRow}>
                  <Text style={styles.userName} numberOfLines={1}>{u.display_name || u.email || u.user_id.slice(0, 12)}</Text>
                  {u.is_admin && <Text style={styles.adminPill}>ADMIN</Text>}
                </View>
                <Text style={styles.userEmail} numberOfLines={1}>{u.email || "(no email)"}</Text>
                <View style={styles.userMeta}>
                  <View style={[styles.tierPill, active ? styles.tierPillActive : styles.tierPillInactive]}>
                    <Text style={[styles.tierPillText, active ? { color: "#16a34a" } : { color: colors.textSubtle }]}>
                      {e.tier.toUpperCase()} · {isComp ? "COMP" : e.source.toUpperCase()}
                    </Text>
                  </View>
                  {e.expires_at && (
                    <Text style={styles.userMetaText}>Until {formatExp(e.expires_at)}</Text>
                  )}
                </View>
                {e.note && <Text style={styles.userNote} numberOfLines={1}>“{e.note}”</Text>}
              </View>
              {isComp ? (
                <TouchableOpacity
                  testID={`revoke-${u.email}`}
                  style={[styles.smallBtn, { borderColor: colors.error }]}
                  onPress={() => revoke(u.email)}
                  disabled={busy === `revoke-${u.email}`}
                >
                  {busy === `revoke-${u.email}` ? <ActivityIndicator color={colors.error} size="small" /> : (
                    <Text style={[styles.smallBtnText, { color: colors.error }]}>Revoke</Text>
                  )}
                </TouchableOpacity>
              ) : u.email ? (
                <TouchableOpacity
                  testID={`quick-grant-${u.email}`}
                  style={[styles.smallBtn, { borderColor: colors.primary }]}
                  onPress={() => grant(u.email!)}
                  disabled={busy === `grant-${u.email}`}
                >
                  {busy === `grant-${u.email}` ? <ActivityIndicator color={colors.primary} size="small" /> : (
                    <Text style={[styles.smallBtnText, { color: colors.primary }]}>Grant</Text>
                  )}
                </TouchableOpacity>
              ) : null}
            </View>
          );
        })}

        <View style={{ height: 80 }} />
      </KeyboardAwareScrollView>

      {toast && (
        <View testID="admin-toast" style={[styles.toast, { pointerEvents: "none" }]}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: spacing.lg, gap: 8 },
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: spacing.md, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: "#fff" },
  iconBtn: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: radii.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: "#fff" },
  title: { color: colors.text, fontSize: 17, fontWeight: "800", fontFamily: fonts.bold },
  subtitle: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  scroll: { padding: spacing.md, paddingBottom: 80 },

  deniedTitle: { color: colors.error, fontSize: 18, fontWeight: "800", marginTop: 12 },
  deniedDesc: { color: colors.textMuted, fontSize: 13, textAlign: "center", marginTop: 6, lineHeight: 18, maxWidth: 320 },

  grantCard: { padding: spacing.md, borderRadius: radii.md, backgroundColor: "#fff", borderWidth: 1, borderColor: colors.border },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: "800" },
  cardDesc: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  fieldLabel: { color: colors.textSubtle, fontSize: 10, fontWeight: "800", letterSpacing: 1.5, textTransform: "uppercase", marginTop: 14, marginBottom: 6 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, backgroundColor: "#fff", paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text },
  chipsRow: { gap: 8, paddingRight: spacing.md },
  chip: { paddingHorizontal: 14, height: 34, borderRadius: 17, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", backgroundColor: "#fff" },
  chipActive: { borderColor: colors.primary, backgroundColor: "#EEF2FF" },
  chipText: { color: colors.textMuted, fontWeight: "700", fontSize: 12 },
  chipTextActive: { color: colors.primary },
  grantBtn: { backgroundColor: colors.primary, paddingVertical: 13, borderRadius: radii.sm, marginTop: 16, alignItems: "center" },
  grantBtnText: { color: "#fff", fontWeight: "800", fontSize: 14 },

  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 22, marginBottom: 8 },
  sectionHeaderText: { color: colors.text, fontWeight: "800", fontSize: 15 },

  userCard: { flexDirection: "row", alignItems: "center", gap: 12, padding: spacing.md, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: "#fff", marginTop: 8 },
  userRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  userName: { color: colors.text, fontWeight: "700", fontSize: 14, flexShrink: 1 },
  userEmail: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  userMeta: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" },
  userMetaText: { color: colors.textSubtle, fontSize: 11 },
  userNote: { color: colors.textMuted, fontSize: 11, fontStyle: "italic", marginTop: 4 },
  adminPill: { color: "#7c3aed", fontSize: 9, fontWeight: "800", letterSpacing: 1.5, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: "#F3E8FF", overflow: "hidden" },
  tierPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, borderWidth: 1 },
  tierPillActive: { borderColor: "#16a34a", backgroundColor: "#ECFDF5" },
  tierPillInactive: { borderColor: colors.border, backgroundColor: colors.surface },
  tierPillText: { fontSize: 9, fontWeight: "800", letterSpacing: 1.2 },
  smallBtn: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: radii.sm, borderWidth: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#fff", minWidth: 70 },
  smallBtnText: { fontWeight: "800", fontSize: 12 },

  toast: { position: "absolute", left: 16, right: 16, bottom: 24, backgroundColor: colors.text, paddingHorizontal: 16, paddingVertical: 12, borderRadius: radii.sm, alignItems: "center" },
  toastText: { color: "#fff", fontWeight: "600", fontSize: 13, textAlign: "center" },
});
