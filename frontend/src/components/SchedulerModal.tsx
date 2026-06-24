import { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Modal, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radii, spacing } from "@/src/theme";

type Platform = "linkedin" | "facebook" | "instagram";

type Props = {
  visible: boolean;
  onClose: () => void;
  onConfirm: (isoDatetime: string, platforms: Platform[]) => Promise<void> | void;
  defaultPlatforms?: Platform[]; // Pre-selected, usually company's linked platforms
  linkedPlatforms?: Platform[]; // Which have linked accounts (enabled chips). Others are dimmed.
  contentPreview?: string; // First few chars of post being scheduled
  hasImage?: boolean; // Image attached → Instagram available
};

const PLATFORMS: { key: Platform; label: string; icon: keyof typeof import("@expo/vector-icons/build/Ionicons").default.glyphMap; color: string }[] = [
  { key: "linkedin", label: "LinkedIn", icon: "logo-linkedin", color: "#0A66C2" },
  { key: "facebook", label: "Facebook", icon: "logo-facebook", color: "#1877F2" },
  { key: "instagram", label: "Instagram", icon: "logo-instagram", color: "#E1306C" },
];

const WEEKDAY_FULL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function nextWeekday(weekday: number, hour: number, minute = 0): Date {
  // weekday: 0=Sun..6=Sat
  const now = new Date();
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  let diff = (weekday - d.getDay() + 7) % 7;
  if (diff === 0 && d.getTime() <= now.getTime()) diff = 7;
  d.setDate(d.getDate() + diff);
  return d;
}

function tomorrowAt(hour: number, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function inMinutes(min: number): Date {
  return new Date(Date.now() + min * 60_000);
}

function formatDateLabel(d: Date): string {
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  if (sameDay) return "Today";
  if (isTomorrow) return "Tomorrow";
  return `${WEEKDAY_FULL[d.getDay()]}, ${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
}

function formatTimeLabel(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, "0")} ${ampm}`;
}

export default function SchedulerModal({
  visible,
  onClose,
  onConfirm,
  defaultPlatforms,
  linkedPlatforms,
  contentPreview,
  hasImage,
}: Props) {
  const [when, setWhen] = useState<Date>(() => tomorrowAt(9));
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [activePreset, setActivePreset] = useState<string | null>("tomorrow9");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset state when modal opens
  useEffect(() => {
    if (visible) {
      setWhen(tomorrowAt(9));
      setActivePreset("tomorrow9");
      setErr(null);
      setBusy(false);
      // Pre-select linked platforms (excluding instagram if no image)
      const initial = (defaultPlatforms || linkedPlatforms || []).filter((p) => p !== "instagram" || hasImage);
      setPlatforms(initial.length > 0 ? initial : ["linkedin"]);
    }
  }, [visible, defaultPlatforms, linkedPlatforms, hasImage]);

  const presets = useMemo(() => [
    { key: "in30", label: "In 30 min", build: () => inMinutes(30) },
    { key: "in2h", label: "In 2 hours", build: () => inMinutes(120) },
    { key: "tonight", label: "Tonight 6pm", build: () => { const d = new Date(); d.setHours(18, 0, 0, 0); return d.getTime() > Date.now() ? d : tomorrowAt(18); } },
    { key: "tomorrow9", label: "Tomorrow 9am", build: () => tomorrowAt(9) },
    { key: "tomorrow5", label: "Tomorrow 5pm", build: () => tomorrowAt(17) },
    { key: "friday", label: "This Fri 9am", build: () => nextWeekday(5, 9) },
    { key: "monday", label: "Next Mon 9am", build: () => nextWeekday(1, 9) },
  ], []);

  const applyPreset = (key: string, build: () => Date) => {
    setActivePreset(key);
    setWhen(build());
  };

  const adjustDate = (deltaDays: number) => {
    setActivePreset(null);
    const d = new Date(when);
    d.setDate(d.getDate() + deltaDays);
    if (d.getTime() <= Date.now()) return;
    setWhen(d);
  };

  const adjustTime = (deltaMinutes: number) => {
    setActivePreset(null);
    const d = new Date(when);
    d.setMinutes(d.getMinutes() + deltaMinutes);
    if (d.getTime() <= Date.now()) return;
    setWhen(d);
  };

  const togglePlatform = (p: Platform) => {
    setPlatforms((cur) => cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]);
  };

  const isLinked = (p: Platform) => (linkedPlatforms || []).includes(p);
  const igAllowed = hasImage === true;

  const submit = async () => {
    setErr(null);
    if (platforms.length === 0) {
      setErr("Select at least one platform.");
      return;
    }
    if (when.getTime() <= Date.now() + 30_000) {
      setErr("Pick a time at least 30s in the future.");
      return;
    }
    if (platforms.includes("instagram") && !igAllowed) {
      setErr("Instagram requires an image — generate one first.");
      return;
    }
    setBusy(true);
    try {
      await onConfirm(when.toISOString(), platforms);
    } catch (e: any) {
      setErr((e?.message || "Schedule failed").slice(0, 160));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Schedule post</Text>
              {contentPreview ? (
                <Text style={styles.preview} numberOfLines={2}>&ldquo;{contentPreview}&rdquo;</Text>
              ) : null}
            </View>
            <TouchableOpacity testID="sched-close" onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={24} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView style={{ maxHeight: "75%" }} contentContainerStyle={{ paddingBottom: 12 }}>
            {/* Quick presets */}
            <Text style={styles.sectionLabel}>Quick pick</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.presetsRow}>
              {presets.map((p) => {
                const isActive = activePreset === p.key;
                return (
                  <TouchableOpacity
                    key={p.key}
                    testID={`sched-preset-${p.key}`}
                    style={[styles.presetChip, isActive && styles.presetChipActive]}
                    onPress={() => applyPreset(p.key, p.build)}
                  >
                    <Text style={[styles.presetText, isActive && styles.presetTextActive]}>{p.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            {/* Date stepper */}
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sectionLabel}>Date</Text>
                <View style={styles.stepperRow}>
                  <TouchableOpacity testID="sched-date-prev" onPress={() => adjustDate(-1)} style={styles.stepperBtn}>
                    <Ionicons name="chevron-back" size={18} color={colors.text} />
                  </TouchableOpacity>
                  <View style={styles.stepperValue}>
                    <Text style={styles.stepperText}>{formatDateLabel(when)}</Text>
                  </View>
                  <TouchableOpacity testID="sched-date-next" onPress={() => adjustDate(1)} style={styles.stepperBtn}>
                    <Ionicons name="chevron-forward" size={18} color={colors.text} />
                  </TouchableOpacity>
                </View>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.sectionLabel}>Time</Text>
                <View style={styles.stepperRow}>
                  <TouchableOpacity testID="sched-time-prev" onPress={() => adjustTime(-15)} style={styles.stepperBtn}>
                    <Ionicons name="chevron-back" size={18} color={colors.text} />
                  </TouchableOpacity>
                  <View style={styles.stepperValue}>
                    <Text style={styles.stepperText}>{formatTimeLabel(when)}</Text>
                  </View>
                  <TouchableOpacity testID="sched-time-next" onPress={() => adjustTime(15)} style={styles.stepperBtn}>
                    <Ionicons name="chevron-forward" size={18} color={colors.text} />
                  </TouchableOpacity>
                </View>
              </View>
            </View>
            <View style={styles.quickHourRow}>
              {[7, 9, 12, 15, 17, 19].map((h) => (
                <TouchableOpacity
                  key={h}
                  testID={`sched-quick-hour-${h}`}
                  style={styles.quickHourChip}
                  onPress={() => {
                    const d = new Date(when);
                    d.setHours(h, 0, 0, 0);
                    if (d.getTime() <= Date.now()) {
                      d.setDate(d.getDate() + 1);
                    }
                    setActivePreset(null);
                    setWhen(d);
                  }}
                >
                  <Text style={styles.quickHourText}>{(h % 12) || 12}{h >= 12 ? "pm" : "am"}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Platforms */}
            <Text style={styles.sectionLabel}>Post to</Text>
            <View style={styles.platformsRow}>
              {PLATFORMS.map((p) => {
                const selected = platforms.includes(p.key);
                const linked = isLinked(p.key);
                const disabled = !linked || (p.key === "instagram" && !igAllowed);
                return (
                  <TouchableOpacity
                    key={p.key}
                    testID={`sched-platform-${p.key}`}
                    style={[
                      styles.platformChip,
                      { borderColor: p.color },
                      selected && !disabled && { backgroundColor: p.color },
                      disabled && styles.platformChipDisabled,
                    ]}
                    onPress={() => !disabled && togglePlatform(p.key)}
                    disabled={disabled}
                    activeOpacity={0.8}
                  >
                    <Ionicons name={p.icon} size={16} color={selected && !disabled ? "#fff" : p.color} />
                    <Text style={[
                      styles.platformChipText,
                      { color: selected && !disabled ? "#fff" : p.color },
                      disabled && { color: colors.textSubtle },
                    ]}>{p.label}</Text>
                    {!linked && <Text style={styles.platformWarn}>Not linked</Text>}
                    {linked && p.key === "instagram" && !igAllowed && <Text style={styles.platformWarn}>Needs image</Text>}
                  </TouchableOpacity>
                );
              })}
            </View>

            {err && (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle" size={14} color={colors.error} />
                <Text style={styles.errorText}>{err}</Text>
              </View>
            )}
          </ScrollView>

          <View style={styles.footer}>
            <TouchableOpacity testID="sched-cancel" style={[styles.btn, styles.btnGhost]} onPress={onClose} disabled={busy}>
              <Text style={styles.btnGhostText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity testID="sched-confirm" style={[styles.btn, styles.btnPrimary, busy && { opacity: 0.6 }]} onPress={submit} disabled={busy}>
              {busy ? <ActivityIndicator color="#fff" /> : (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Ionicons name="calendar" size={16} color="#fff" />
                  <Text style={styles.btnPrimaryText}>
                    Schedule for {formatDateLabel(when)}, {formatTimeLabel(when)}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: "#fff", borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: spacing.md, paddingTop: 8, paddingBottom: 16, maxHeight: "92%" },
  handle: { width: 40, height: 4, backgroundColor: colors.border, borderRadius: 2, alignSelf: "center", marginBottom: 12 },
  header: { flexDirection: "row", alignItems: "flex-start", gap: 12, marginBottom: 8 },
  title: { color: colors.text, fontSize: 18, fontWeight: "800" },
  preview: { color: colors.textMuted, fontSize: 12, marginTop: 4, fontStyle: "italic" },

  sectionLabel: { color: colors.textSubtle, fontSize: 10, fontWeight: "800", letterSpacing: 1.5, textTransform: "uppercase", marginTop: 14, marginBottom: 8 },
  presetsRow: { gap: 8, paddingRight: spacing.md },
  presetChip: { paddingHorizontal: 14, height: 36, borderRadius: 18, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", backgroundColor: "#fff" },
  presetChipActive: { borderColor: colors.primary, backgroundColor: colors.primary },
  presetText: { color: colors.textMuted, fontWeight: "700", fontSize: 13 },
  presetTextActive: { color: "#fff" },

  row: { flexDirection: "row", gap: 12 },
  stepperRow: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, backgroundColor: "#fff" },
  stepperBtn: { width: 40, height: 44, alignItems: "center", justifyContent: "center" },
  stepperValue: { flex: 1, alignItems: "center", justifyContent: "center", borderLeftWidth: 1, borderRightWidth: 1, borderColor: colors.border, height: 44 },
  stepperText: { color: colors.text, fontWeight: "700", fontSize: 14 },

  quickHourRow: { flexDirection: "row", gap: 6, marginTop: 8, flexWrap: "wrap" },
  quickHourChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  quickHourText: { color: colors.textMuted, fontSize: 12, fontWeight: "600" },

  platformsRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  platformChip: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderRadius: radii.sm, backgroundColor: "#fff", flexShrink: 0 },
  platformChipDisabled: { opacity: 0.45 },
  platformChipText: { fontWeight: "700", fontSize: 13 },
  platformWarn: { color: colors.error, fontSize: 10, fontWeight: "700", marginLeft: 4 },

  errorBox: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10, padding: 10, borderRadius: radii.sm, backgroundColor: "#FEF2F2", borderWidth: 1, borderColor: colors.error },
  errorText: { color: colors.error, fontSize: 12, fontWeight: "600", flex: 1 },

  footer: { flexDirection: "row", gap: 8, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border },
  btn: { paddingHorizontal: 14, paddingVertical: 12, borderRadius: radii.sm, alignItems: "center", justifyContent: "center" },
  btnGhost: { borderWidth: 1, borderColor: colors.border, backgroundColor: "transparent", minWidth: 88 },
  btnGhostText: { color: colors.text, fontWeight: "700" },
  btnPrimary: { flex: 1, backgroundColor: colors.primary },
  btnPrimaryText: { color: "#fff", fontWeight: "800", fontSize: 14 },
});
