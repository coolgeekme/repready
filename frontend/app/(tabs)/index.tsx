import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/src/contexts/AuthContext";
import { api } from "@/src/lib/api";
import { colors, fonts, radii, spacing } from "@/src/theme";

type Tool = {
  key: string;
  title: string;
  desc: string;
  icon: keyof typeof Ionicons.glyphMap;
  route: string;
};

const TOOLS: Tool[] = [
  { key: "cold-email", title: "Cold Email", desc: "3 variations", icon: "mail-outline", route: "/generate/cold-email" },
  { key: "objection", title: "Objection", desc: "3 ways to handle", icon: "shield-checkmark-outline", route: "/generate/objection" },
  { key: "call-script", title: "Call Script", desc: "Openers + questions", icon: "call-outline", route: "/generate/call-script" },
  { key: "company-intel", title: "Company Intel", desc: "Personalization hooks", icon: "search-outline", route: "/generate/company-intel" },
  { key: "re-engagement", title: "Re-Engage", desc: "Follow-up angles", icon: "refresh-outline", route: "/generate/re-engagement" },
  { key: "linkedin-post", title: "Social Post", desc: "Ready-to-post", icon: "share-social-outline", route: "/generate/linkedin-post" },
];

export default function Home() {
  const router = useRouter();
  const { user } = useAuth();
  const [daily, setDaily] = useState<any | null>(null);
  const [profile, setProfile] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, d] = await Promise.all([api.getProfile(), api.dailyPrompt()]);
      setProfile(p);
      setDaily(d);
    } catch (e) {
      console.warn("Home load failed", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = () => { setRefreshing(true); load(); };

  const firstName = (user?.displayName || user?.email || "").split(" ")[0].split("@")[0];
  const needsCompany = !profile?.company_offerings;

  return (
    <SafeAreaView edges={["top"]} style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.overline}>RepReady</Text>
            <Text style={styles.h1}>Hi {firstName || "there"} 👋</Text>
            <Text style={styles.sub}>
              {profile?.role || "Set your role"} · {profile?.industry || "Set your industry"}
              {profile?.company_name ? ` · ${profile.company_name}` : ""}
            </Text>
          </View>
          <TouchableOpacity testID="home-settings-button" onPress={() => router.push("/(tabs)/settings")} style={styles.iconBtn}>
            <Ionicons name="settings-outline" size={20} color={colors.text} />
          </TouchableOpacity>
        </View>

        {/* Daily prompt */}
        <View testID="daily-prompt-card" style={styles.dailyCard}>
          <Text style={styles.dailyLabel}>Today&apos;s focus · {daily?.date || ""}</Text>
          {loading && !daily ? (
            <ActivityIndicator color="#fff" style={{ marginTop: 16 }} />
          ) : daily ? (
            <>
              <Text style={styles.dailyFocus}>{daily.focus}</Text>
              <View style={styles.steps}>
                {(daily.action_steps || []).map((s: string, i: number) => (
                  <View key={i} style={styles.stepRow}>
                    <View style={styles.stepDot}><Text style={styles.stepNum}>{i + 1}</Text></View>
                    <Text style={styles.stepText}>{s}</Text>
                  </View>
                ))}
              </View>
              {daily.quote && <Text style={styles.dailyQuote}>“{daily.quote}”</Text>}
            </>
          ) : (
            <Text style={styles.dailyFocus}>Pull to refresh.</Text>
          )}
        </View>

        {/* Tools grid */}
        <Text style={styles.sectionLabel}>Generators</Text>
        {!loading && needsCompany && (
          <TouchableOpacity
            testID="company-cta-banner"
            style={styles.companyBanner}
            onPress={() => router.push("/(tabs)/settings")}
            activeOpacity={0.8}
          >
            <View style={styles.companyBannerIcon}>
              <Ionicons name="business" size={18} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.companyBannerTitle}>Tell us about your company</Text>
              <Text style={styles.companyBannerDesc}>
                Add what you sell so every email, script & post is aligned to your offerings.
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textSubtle} />
          </TouchableOpacity>
        )}
        <View style={styles.grid}>
          {TOOLS.map((t) => (
            <TouchableOpacity
              key={t.key}
              testID={`tool-${t.key}`}
              style={styles.toolCard}
              onPress={() => router.push(t.route as any)}
              activeOpacity={0.7}
            >
              <View style={styles.toolIconWrap}>
                <Ionicons name={t.icon} size={20} color={colors.primary} />
              </View>
              <Text style={styles.toolTitle}>{t.title}</Text>
              <Text style={styles.toolDesc}>{t.desc}</Text>
              <View style={styles.toolArrow}>
                <Ionicons name="arrow-forward" size={14} color={colors.text} />
              </View>
            </TouchableOpacity>
          ))}
        </View>

        {/* CTA */}
        <TouchableOpacity testID="home-history-cta" style={styles.flatCta} onPress={() => router.push("/(tabs)/history")}>
          <Ionicons name="bookmark-outline" size={18} color={colors.text} />
          <Text style={styles.flatCtaText}>View saved & recent generations</Text>
          <Ionicons name="chevron-forward" size={16} color={colors.textSubtle} />
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xl, gap: spacing.md },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  overline: { color: colors.textSubtle, fontSize: 11, fontWeight: "700", letterSpacing: 2.4, textTransform: "uppercase" },
  h1: { fontSize: 28, fontWeight: "800", color: colors.text, letterSpacing: -0.8, marginTop: 4, fontFamily: fonts.heading as string },
  sub: { color: colors.textMuted, fontSize: 14, marginTop: 4 },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm },

  dailyCard: { backgroundColor: colors.black, borderRadius: radii.md, padding: spacing.lg, marginTop: spacing.sm },
  dailyLabel: { color: "#9CA3AF", fontSize: 11, fontWeight: "700", letterSpacing: 1.6, textTransform: "uppercase" },
  dailyFocus: { color: "#fff", fontSize: 22, fontWeight: "700", marginTop: 8, letterSpacing: -0.4, lineHeight: 28 },
  steps: { marginTop: 16, gap: 10 },
  stepRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  stepDot: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", marginTop: 1 },
  stepNum: { color: "#fff", fontSize: 11, fontWeight: "800" },
  stepText: { color: "#E5E7EB", fontSize: 14, flex: 1, lineHeight: 20 },
  dailyQuote: { color: "#9CA3AF", fontSize: 13, fontStyle: "italic", marginTop: 14, lineHeight: 18 },

  sectionLabel: { color: colors.textSubtle, fontSize: 11, fontWeight: "700", letterSpacing: 2.4, textTransform: "uppercase", marginTop: spacing.md },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  toolCard: { width: "48%", borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, padding: spacing.md, backgroundColor: "#fff", minHeight: 120 },
  toolIconWrap: { width: 36, height: 36, borderRadius: radii.sm, backgroundColor: "#EEF2FF", alignItems: "center", justifyContent: "center", marginBottom: 10 },
  toolTitle: { fontSize: 15, fontWeight: "700", color: colors.text, letterSpacing: -0.2 },
  toolDesc: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  toolArrow: { position: "absolute", top: 12, right: 12, opacity: 0.6 },

  flatCta: { marginTop: spacing.md, flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 14, paddingHorizontal: 14, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm },
  flatCtaText: { flex: 1, color: colors.text, fontSize: 14, fontWeight: "600" },

  companyBanner: { flexDirection: "row", alignItems: "center", gap: 12, padding: spacing.md, borderRadius: radii.sm, backgroundColor: "#EEF2FF", borderWidth: 1, borderColor: "#C7D2FE" },
  companyBannerIcon: { width: 36, height: 36, borderRadius: radii.sm, backgroundColor: "#fff", alignItems: "center", justifyContent: "center" },
  companyBannerTitle: { color: colors.text, fontWeight: "700", fontSize: 14 },
  companyBannerDesc: { color: colors.textMuted, fontSize: 12, marginTop: 2, lineHeight: 17 },
});
