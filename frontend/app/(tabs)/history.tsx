import { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/lib/api";
import { colors, fonts, radii, spacing } from "@/src/theme";

const TYPE_LABELS: Record<string, { label: string; icon: keyof typeof Ionicons.glyphMap }> = {
  cold_email: { label: "Cold Email", icon: "mail-outline" },
  objection: { label: "Objection", icon: "shield-checkmark-outline" },
  call_script: { label: "Call Script", icon: "call-outline" },
  company_intel: { label: "Company Intel", icon: "search-outline" },
  re_engagement: { label: "Re-Engage", icon: "refresh-outline" },
  linkedin_post: { label: "Social Post", icon: "share-social-outline" },
};

type Tab = "all" | "saved" | "scheduled";

/** Format an ISO datetime into a friendly "Tomorrow at 9:30 AM" style label. */
function formatScheduled(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
    const diffMin = Math.round(diffMs / 60000);
    const overdue = diffMs < 0;
    const abs = Math.abs(diffMin);
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

    if (abs < 60) return overdue ? `${abs}m overdue` : `in ${abs}m`;
    if (abs < 60 * 24) {
      const h = Math.round(abs / 60);
      return overdue ? `${h}h overdue` : `in ${h}h · ${time}`;
    }
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const target = new Date(d); target.setHours(0, 0, 0, 0);
    const dayDiff = Math.round((target.getTime() - today.getTime()) / (86400000));
    if (dayDiff === 1) return `Tomorrow at ${time}`;
    if (dayDiff === 0) return `Today at ${time}`;
    if (dayDiff === -1) return `Yesterday at ${time}`;
    return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} at ${time}`;
  } catch {
    return iso;
  }
}

const PLATFORM_META: Record<string, { icon: keyof typeof Ionicons.glyphMap; color: string; label: string }> = {
  linkedin: { icon: "logo-linkedin", color: "#0A66C2", label: "LinkedIn" },
  facebook: { icon: "logo-facebook", color: "#1877F2", label: "Facebook" },
  instagram: { icon: "logo-instagram", color: "#E1306C", label: "Instagram" },
  gmail: { icon: "mail", color: "#EA4335", label: "Emailed" },
  outlook: { icon: "mail", color: "#0078D4", label: "Emailed" },
};

export default function History() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("all");
  const [items, setItems] = useState<any[]>([]);
  const [scheduled, setScheduled] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      if (tab === "scheduled") {
        const res = await api.listScheduled();
        setScheduled(res.items || []);
      } else {
        const res = await api.listHistory(tab === "saved");
        setItems(res.items || []);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [tab]);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));

  const toggle = async (id: string) => {
    await api.toggleSave(id);
    load();
  };

  const remove = async (id: string) => {
    await api.deleteHistory(id);
    load();
  };

  const cancelScheduled = (item: any) => {
    Alert.alert(
      "Cancel scheduled post?",
      `This will remove the ${item.platforms?.join(" + ") || ""} post scheduled for ${formatScheduled(item.scheduled_for)}.`,
      [
        { text: "Keep it", style: "cancel" },
        {
          text: "Cancel post",
          style: "destructive",
          onPress: async () => {
            try {
              setCancelling(item.id);
              await api.deleteScheduled(item.id);
              await load();
            } catch (e: any) {
              Alert.alert("Couldn't cancel", e?.message || "Please try again.");
            } finally {
              setCancelling(null);
            }
          },
        },
      ],
    );
  };

  const renderStatusPill = (status: string, isOverdue: boolean) => {
    let color = colors.textSubtle;
    let bg = "#f0f0f0";
    let text = status;
    if (status === "scheduled") { color = colors.primary; bg = "#EEF2FF"; text = "Scheduled"; }
    if (status === "posted") { color = "#0f7a3d"; bg = "#e6f4ec"; text = "Posted"; }
    if (status === "failed") { color = colors.error; bg = "#FEE2E2"; text = "Failed"; }
    if (status === "posting") { color = "#8a5a00"; bg = "#FFF4CC"; text = "Posting…"; }
    if (isOverdue && status === "scheduled") { color = "#8a5a00"; bg = "#FFF4CC"; text = "Firing now"; }
    return (
      <View style={[styles.statusPill, { backgroundColor: bg }]}>
        <Text style={[styles.statusPillText, { color }]}>{text}</Text>
      </View>
    );
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.container}>
      <View style={styles.headerWrap}>
        <Text style={styles.overline}>Library</Text>
        <Text style={styles.h1}>Saved &amp; scheduled</Text>
        <View style={styles.chipsRow}>
          <Chip testID="library-filter-all" label="All" active={tab === "all"} onPress={() => setTab("all")} />
          <Chip testID="library-filter-saved" label="Saved" active={tab === "saved"} onPress={() => setTab("saved")} />
          <Chip testID="library-filter-scheduled" label="Scheduled" active={tab === "scheduled"} onPress={() => setTab("scheduled")} count={scheduled.filter((s) => s.status === "scheduled").length} />
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
      >
        {loading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
        ) : tab === "scheduled" ? (
          scheduled.length === 0 ? (
            <View style={styles.empty}>
              <View style={styles.emptyIcon}><Ionicons name="time-outline" size={28} color={colors.textSubtle} /></View>
              <Text style={styles.emptyTitle}>No scheduled posts</Text>
              <Text style={styles.emptyDesc}>Generate a social post and tap the clock icon to schedule it for later.</Text>
              <TouchableOpacity testID="library-empty-cta-scheduled" style={styles.primaryBtn} onPress={() => router.push("/(tabs)")}>
                <Text style={styles.primaryBtnText}>Open generators</Text>
              </TouchableOpacity>
            </View>
          ) : (
            scheduled.map((s) => {
              const isOverdue = new Date(s.scheduled_for).getTime() < Date.now() && s.status === "scheduled";
              const results = s.results || [];
              return (
                <View key={s.id} testID={`scheduled-item-${s.id}`} style={styles.schedCard}>
                  <View style={styles.schedTopRow}>
                    <View style={styles.schedIconWrap}>
                      <Ionicons name="calendar-outline" size={18} color={colors.primary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.schedWhen}>{formatScheduled(s.scheduled_for)}</Text>
                      <Text style={styles.schedFullDate}>
                        {new Date(s.scheduled_for).toLocaleString([], {
                          weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                        })}
                      </Text>
                    </View>
                    {renderStatusPill(s.status || "scheduled", isOverdue)}
                  </View>

                  <Text style={styles.schedContent} numberOfLines={4}>{s.content}</Text>

                  <View style={styles.schedPlatforms}>
                    {(s.platforms || []).map((p: string) => {
                      const m = PLATFORM_META[p];
                      if (!m) return null;
                      const result = results.find((r: any) => r.platform === p);
                      const done = result?.success;
                      const failed = result && result.success === false;
                      return (
                        <View key={p} style={[
                          styles.platformChip,
                          { borderColor: `${m.color}55` },
                          done && { backgroundColor: `${m.color}18` },
                          failed && { backgroundColor: "#FEE2E2", borderColor: colors.error },
                        ]}>
                          <Ionicons name={m.icon} size={12} color={failed ? colors.error : m.color} />
                          <Text style={[styles.platformChipText, { color: failed ? colors.error : m.color }]}>
                            {m.label}
                            {done ? " ✓" : failed ? " ✕" : ""}
                          </Text>
                        </View>
                      );
                    })}
                  </View>

                  {/* Show any error messages inline */}
                  {results.some((r: any) => r.success === false && r.error) ? (
                    <View style={styles.schedErrorBox}>
                      {results.filter((r: any) => r.success === false && r.error).map((r: any, i: number) => (
                        <Text key={i} style={styles.schedErrorText}>
                          <Text style={{ fontWeight: "700" }}>{PLATFORM_META[r.platform]?.label || r.platform}:</Text> {r.error}
                        </Text>
                      ))}
                    </View>
                  ) : null}

                  {s.status === "scheduled" ? (
                    <TouchableOpacity
                      testID={`scheduled-cancel-${s.id}`}
                      style={styles.cancelBtn}
                      onPress={() => cancelScheduled(s)}
                      disabled={cancelling === s.id}
                      activeOpacity={0.8}
                    >
                      {cancelling === s.id ? (
                        <ActivityIndicator size="small" color={colors.error} />
                      ) : (
                        <Ionicons name="close-circle-outline" size={16} color={colors.error} />
                      )}
                      <Text style={styles.cancelBtnText}>{cancelling === s.id ? "Cancelling…" : "Cancel post"}</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              );
            })
          )
        ) : items.length === 0 ? (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}><Ionicons name="document-text-outline" size={28} color={colors.textSubtle} /></View>
            <Text style={styles.emptyTitle}>Nothing here yet</Text>
            <Text style={styles.emptyDesc}>Generate a cold email or LinkedIn post — it&apos;ll land here automatically.</Text>
            <TouchableOpacity testID="library-empty-cta" style={styles.primaryBtn} onPress={() => router.push("/(tabs)")}>
              <Text style={styles.primaryBtnText}>Open generators</Text>
            </TouchableOpacity>
          </View>
        ) : (
          items.map((it) => {
            const meta = TYPE_LABELS[it.type] || { label: it.type, icon: "document-outline" };
            return (
              <TouchableOpacity
                key={it.id}
                testID={`history-item-${it.id}`}
                style={styles.row}
                activeOpacity={0.7}
                onPress={() => router.push({ pathname: "/generate/[type]", params: { type: it.type.replace("_", "-"), historyId: it.id } } as any)}
              >
                <View style={styles.rowIcon}><Ionicons name={meta.icon as any} size={18} color={colors.primary} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{it.title}</Text>
                  <Text style={styles.rowMeta}>{meta.label} · {new Date(it.created_at).toLocaleDateString()}</Text>
                  {Array.isArray(it.posted_to) && it.posted_to.length > 0 && (
                    <View style={{ flexDirection: "row", gap: 4, marginTop: 4 }}>
                      {it.posted_to.map((p: any, idx: number) => {
                        const m = PLATFORM_META[p.platform];
                        if (!m) return null;
                        return (
                          <View key={idx} testID={`posted-${p.platform}-${it.id}`} style={{ flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: `${m.color}15` }}>
                            <Ionicons name={m.icon as any} size={11} color={m.color} />
                            <Text style={{ fontSize: 10, color: m.color, fontWeight: "700" }}>Posted</Text>
                          </View>
                        );
                      })}
                    </View>
                  )}
                </View>
                <TouchableOpacity testID={`history-save-${it.id}`} onPress={() => toggle(it.id)} hitSlop={8}>
                  <Ionicons name={it.saved ? "bookmark" : "bookmark-outline"} size={20} color={it.saved ? colors.primary : colors.textSubtle} />
                </TouchableOpacity>
                <TouchableOpacity testID={`history-delete-${it.id}`} onPress={() => remove(it.id)} hitSlop={8} style={{ marginLeft: 12 }}>
                  <Ionicons name="trash-outline" size={18} color={colors.textSubtle} />
                </TouchableOpacity>
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Chip({ label, active, onPress, testID, count }: { label: string; active: boolean; onPress: () => void; testID: string; count?: number }) {
  return (
    <TouchableOpacity testID={testID} onPress={onPress} style={[chipStyles.chip, active && chipStyles.chipActive]}>
      <Text style={[chipStyles.chipText, active && chipStyles.chipTextActive]}>{label}</Text>
      {typeof count === "number" && count > 0 ? (
        <View style={[chipStyles.countBadge, active && chipStyles.countBadgeActive]}>
          <Text style={[chipStyles.countBadgeText, active && chipStyles.countBadgeTextActive]}>{count}</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

const chipStyles = StyleSheet.create({
  chip: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, height: 36, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.border, justifyContent: "center", flexShrink: 0 },
  chipActive: { borderColor: colors.primary, backgroundColor: "#EEF2FF" },
  chipText: { color: colors.textMuted, fontWeight: "600", fontSize: 13 },
  chipTextActive: { color: colors.primary },
  countBadge: { minWidth: 20, height: 18, borderRadius: 9, paddingHorizontal: 6, backgroundColor: colors.textSubtle, alignItems: "center", justifyContent: "center" },
  countBadgeActive: { backgroundColor: colors.primary },
  countBadgeText: { color: "#fff", fontSize: 10, fontWeight: "800" },
  countBadgeTextActive: { color: "#fff" },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  headerWrap: { padding: spacing.lg, paddingBottom: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  overline: { color: colors.textSubtle, fontSize: 11, fontWeight: "700", letterSpacing: 2.4, textTransform: "uppercase" },
  h1: { fontSize: 26, fontWeight: "800", color: colors.text, letterSpacing: -0.6, marginTop: 4, fontFamily: fonts.heading as string },
  chipsRow: { flexDirection: "row", gap: 8, marginTop: spacing.md },
  scroll: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xl, gap: 10 },

  row: { flexDirection: "row", alignItems: "center", padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, backgroundColor: "#fff", gap: 12 },
  rowIcon: { width: 36, height: 36, borderRadius: radii.sm, backgroundColor: "#EEF2FF", alignItems: "center", justifyContent: "center" },
  rowTitle: { fontSize: 14, fontWeight: "700", color: colors.text },
  rowMeta: { fontSize: 12, color: colors.textMuted, marginTop: 2 },

  // Scheduled-post card
  schedCard: { padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, backgroundColor: "#fff", gap: 10 },
  schedTopRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  schedIconWrap: { width: 36, height: 36, borderRadius: radii.sm, backgroundColor: "#EEF2FF", alignItems: "center", justifyContent: "center" },
  schedWhen: { fontSize: 15, fontWeight: "800", color: colors.text },
  schedFullDate: { fontSize: 11, color: colors.textSubtle, marginTop: 1 },
  schedContent: { fontSize: 13, color: colors.textMuted, lineHeight: 19, fontStyle: "italic" },
  schedPlatforms: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  platformChip: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, borderWidth: 1, backgroundColor: "#fff" },
  platformChipText: { fontSize: 11, fontWeight: "700" },
  statusPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  statusPillText: { fontSize: 11, fontWeight: "800", letterSpacing: 0.3 },
  cancelBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 4, paddingVertical: 10, borderWidth: 1, borderColor: `${colors.error}55`, borderRadius: radii.sm, backgroundColor: "#FEF2F2" },
  cancelBtnText: { color: colors.error, fontWeight: "700", fontSize: 13 },
  schedErrorBox: { padding: 8, borderRadius: radii.sm, backgroundColor: "#FEF2F2", borderWidth: 1, borderColor: "#FCA5A5" },
  schedErrorText: { fontSize: 11, color: colors.error, lineHeight: 15 },

  empty: { alignItems: "center", padding: spacing.xl, gap: 8, marginTop: 40 },
  emptyIcon: { width: 56, height: 56, borderRadius: radii.sm, backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center", marginBottom: 6 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: colors.text },
  emptyDesc: { color: colors.textMuted, textAlign: "center", maxWidth: 260, lineHeight: 20 },
  primaryBtn: { backgroundColor: colors.primary, paddingHorizontal: 18, paddingVertical: 12, borderRadius: radii.sm, marginTop: spacing.md },
  primaryBtnText: { color: "#fff", fontWeight: "700" },
});
