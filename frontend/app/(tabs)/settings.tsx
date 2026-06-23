import { useCallback, useEffect, useState } from "react";
import { View, Text, TextInput, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as WebBrowser from "expo-web-browser";
import { useAuth } from "@/src/contexts/AuthContext";
import { api } from "@/src/lib/api";
import { colors, fonts, radii, spacing } from "@/src/theme";

const ROLES = ["SDR", "BDR", "AE", "Account Manager", "CSM", "Sales Engineer", "Founder/CEO"];
const INDUSTRIES = ["SaaS", "FinTech", "Healthcare", "Manufacturing", "Education", "E-commerce", "Real Estate", "Marketing"];

type SocialState = { connected: boolean; configured?: boolean };
const SOCIALS: { key: "linkedin" | "facebook" | "instagram"; label: string; icon: keyof typeof Ionicons.glyphMap; color: string }[] = [
  { key: "linkedin", label: "LinkedIn", icon: "logo-linkedin", color: "#0A66C2" },
  { key: "facebook", label: "Facebook", icon: "logo-facebook", color: "#1877F2" },
  { key: "instagram", label: "Instagram", icon: "logo-instagram", color: "#E1306C" },
];

export default function Settings() {
  const { user, signOutUser } = useAuth();
  const [profile, setProfile] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [socials, setSocials] = useState<Record<string, SocialState>>({});
  const [connecting, setConnecting] = useState<string | null>(null);
  const [autoFilling, setAutoFilling] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, ...statuses] = await Promise.all([
        api.getProfile(),
        ...SOCIALS.map((s) => api.socialStatus(s.key)),
      ]);
      setProfile(p || {});
      const map: Record<string, SocialState> = {};
      SOCIALS.forEach((s, i) => { map[s.key] = statuses[i] || { connected: false }; });
      setSocials(map);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async (patch: any) => {
    const next = { ...profile, ...patch };
    setProfile(next);
    setSaving(true);
    try {
      await api.updateProfile(patch);
      setToast("Saved");
      setTimeout(() => setToast(null), 1400);
    } catch (e) {
      setToast("Save failed");
      setTimeout(() => setToast(null), 1400);
    } finally {
      setSaving(false);
    }
  };

  const pickFile = async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: ["application/pdf", "text/plain"], copyToCacheDirectory: true, multiple: false });
    if (res.canceled || !res.assets?.[0]) return;
    const file = res.assets[0];
    try {
      const resp = await fetch(file.uri);
      const blob = await resp.blob();
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result as string;
        const b64 = dataUrl.split(",")[1] || "";
        await save({ guidelines_file_name: file.name, guidelines_file_b64: b64 });
      };
      reader.readAsDataURL(blob);
    } catch (e) {
      setToast("Upload failed");
      setTimeout(() => setToast(null), 1500);
    }
  };

  const connectSocial = async (platform: "linkedin" | "facebook" | "instagram") => {
    setConnecting(platform);
    try {
      const res = await api.socialConnect(platform);
      if (res?.already_connected) {
        setToast(`${platform} already connected`);
        setTimeout(() => setToast(null), 1500);
      } else if (res?.redirect_url) {
        await WebBrowser.openBrowserAsync(res.redirect_url);
      }
      // Refresh status after returning
      const s = await api.socialStatus(platform);
      setSocials((m) => ({ ...m, [platform]: s }));
    } catch (e: any) {
      const msg = e?.message || "";
      if (msg.includes("503")) {
        setToast(`${platform} not configured`);
      } else {
        setToast(`${platform} connect failed`);
      }
      setTimeout(() => setToast(null), 2500);
    } finally {
      setConnecting(null);
    }
  };

  const disconnectSocial = async (platform: "linkedin" | "facebook" | "instagram") => {
    setConnecting(`disconnect-${platform}`);
    try {
      const res = await api.socialDisconnect(platform);
      setSocials((m) => ({ ...m, [platform]: { connected: false, configured: true } }));
      setToast(`${platform} disconnected${res?.deleted ? ` (${res.deleted})` : ""}`);
      setTimeout(() => setToast(null), 1800);
    } catch (e: any) {
      setToast(`${platform} disconnect failed`);
      setTimeout(() => setToast(null), 2000);
    } finally {
      setConnecting(null);
    }
  };

  const autofillCompany = async () => {
    if (!profile.company_name?.trim()) {
      setToast("Enter company name first");
      setTimeout(() => setToast(null), 1500);
      return;
    }
    setAutoFilling(true);
    try {
      const res = await api.companyAutofill(profile.company_name.trim(), profile.company_website);
      const patch = {
        company_offerings: res.company_offerings || profile.company_offerings,
        company_value_props: res.company_value_props || profile.company_value_props,
        industry: res.industry || profile.industry,
        target_audience: res.target_audience || profile.target_audience,
      };
      setProfile({ ...profile, ...patch });
      await api.updateProfile(patch);
      setToast(res.fetched_site ? "Auto-filled from site" : "Auto-filled (no site reached)");
      setTimeout(() => setToast(null), 1800);
    } catch (e: any) {
      setToast("Auto-fill failed");
      setTimeout(() => setToast(null), 1500);
    } finally {
      setAutoFilling(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <ActivityIndicator color={colors.primary} style={{ marginTop: 60 }} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <KeyboardAwareScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.overline}>Profile</Text>
        <Text style={styles.h1}>Settings</Text>
        <Text style={styles.subEmail}>{user?.email}</Text>

        {/* Role chips */}
        <Text style={styles.sectionLabel}>Sales role</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
          {ROLES.map((r) => (
            <TouchableOpacity
              key={r}
              testID={`role-${r}`}
              onPress={() => save({ role: r })}
              style={[styles.chip, profile.role === r && styles.chipActive]}
            >
              <Text style={[styles.chipText, profile.role === r && styles.chipTextActive]}>{r}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Industry chips */}
        <Text style={styles.sectionLabel}>Industry</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
          {INDUSTRIES.map((r) => (
            <TouchableOpacity
              key={r}
              testID={`industry-${r}`}
              onPress={() => save({ industry: r })}
              style={[styles.chip, profile.industry === r && styles.chipActive]}
            >
              <Text style={[styles.chipText, profile.industry === r && styles.chipTextActive]}>{r}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Target audience */}
        <Text style={styles.sectionLabel}>Target audience</Text>
        <TextInput
          testID="settings-target-audience"
          style={styles.input}
          value={profile.target_audience || ""}
          onChangeText={(t) => setProfile({ ...profile, target_audience: t })}
          onBlur={() => save({ target_audience: profile.target_audience || "" })}
          placeholder="VPs of Engineering at mid-market SaaS"
          placeholderTextColor={colors.textSubtle}
        />

        {/* Company info section */}
        <View style={styles.sectionHeader}>
          <Ionicons name="business-outline" size={16} color={colors.primary} />
          <Text style={styles.sectionHeaderText}>Company</Text>
        </View>
        <Text style={styles.helper}>Used as context in every generation so output matches what your company actually sells.</Text>

        <Text style={styles.sectionLabel}>Company name</Text>
        <TextInput
          testID="settings-company-name"
          style={styles.input}
          value={profile.company_name || ""}
          onChangeText={(t) => setProfile({ ...profile, company_name: t })}
          onBlur={() => save({ company_name: profile.company_name || "" })}
          placeholder="Acme Inc."
          placeholderTextColor={colors.textSubtle}
        />

        <Text style={styles.sectionLabel}>Website (optional, recommended)</Text>
        <TextInput
          testID="settings-company-website"
          style={styles.input}
          value={profile.company_website || ""}
          onChangeText={(t) => setProfile({ ...profile, company_website: t })}
          onBlur={() => save({ company_website: profile.company_website || "" })}
          placeholder="acme.com"
          placeholderTextColor={colors.textSubtle}
          autoCapitalize="none"
          keyboardType="url"
        />

        {/* AI Autofill */}
        <TouchableOpacity
          testID="settings-company-autofill"
          style={[styles.autofillBtn, (!profile.company_name?.trim() || autoFilling) && styles.autofillBtnDisabled]}
          onPress={autofillCompany}
          disabled={!profile.company_name?.trim() || autoFilling}
          activeOpacity={0.85}
        >
          {autoFilling ? (
            <>
              <ActivityIndicator color="#fff" />
              <Text style={styles.autofillText}>Researching {profile.company_name || "company"}…</Text>
            </>
          ) : (
            <>
              <Ionicons name="sparkles" size={16} color="#fff" />
              <Text style={styles.autofillText}>Auto-fill with AI</Text>
              <View style={styles.aiBadge}><Text style={styles.aiBadgeText}>AI</Text></View>
            </>
          )}
        </TouchableOpacity>
        <Text style={styles.autofillHelper}>
          Reads your website and fills offerings, value props, industry, and ICP. Edit anything below before relying on it.
        </Text>

        <Text style={styles.sectionLabel}>What does your company sell?</Text>
        <TextInput
          testID="settings-company-offerings"
          style={[styles.input, styles.textarea]}
          value={profile.company_offerings || ""}
          onChangeText={(t) => setProfile({ ...profile, company_offerings: t })}
          onBlur={() => save({ company_offerings: profile.company_offerings || "" })}
          multiline
          placeholder={"Describe your product/service in 2-4 sentences. Who it's for, what it does, how it's delivered."}
          placeholderTextColor={colors.textSubtle}
        />

        <Text style={styles.sectionLabel}>Key value props / differentiators (optional)</Text>
        <TextInput
          testID="settings-company-value-props"
          style={[styles.input, styles.textarea]}
          value={profile.company_value_props || ""}
          onChangeText={(t) => setProfile({ ...profile, company_value_props: t })}
          onBlur={() => save({ company_value_props: profile.company_value_props || "" })}
          multiline
          placeholder={"• 40% faster onboarding\n• SOC 2 compliant\n• Only solution with native Salesforce sync"}
          placeholderTextColor={colors.textSubtle}
        />

        {/* Brand & guidelines section */}
        <View style={styles.sectionHeader}>
          <Ionicons name="reader-outline" size={16} color={colors.primary} />
          <Text style={styles.sectionHeaderText}>Brand & guidelines</Text>
        </View>

        {/* Guidelines paste */}
        <Text style={styles.sectionLabel}>Brand voice (text)</Text>
        <TextInput
          testID="settings-guidelines-text"
          style={[styles.input, styles.textarea]}
          value={profile.guidelines_text || ""}
          onChangeText={(t) => setProfile({ ...profile, guidelines_text: t })}
          onBlur={() => save({ guidelines_text: profile.guidelines_text || "" })}
          multiline
          placeholder="Paste your brand voice, tone, and posting rules..."
          placeholderTextColor={colors.textSubtle}
        />

        {/* Upload */}
        <Text style={styles.sectionLabel}>Guidelines file (PDF or .txt)</Text>
        <TouchableOpacity testID="settings-guidelines-upload" style={styles.uploadBtn} onPress={pickFile}>
          <Ionicons name="cloud-upload-outline" size={18} color={colors.text} />
          <Text style={styles.uploadText}>{profile.guidelines_file_name || "Choose file"}</Text>
          <Text style={styles.uploadHint}>PDF / TXT</Text>
        </TouchableOpacity>

        {/* Social integrations via Composio */}
        <View style={styles.sectionHeader}>
          <Ionicons name="share-social-outline" size={16} color={colors.primary} />
          <Text style={styles.sectionHeaderText}>Social accounts</Text>
        </View>
        <Text style={styles.helper}>Connect once, then post drafts straight from RepReady.</Text>

        {SOCIALS.map((s) => {
          const state = socials[s.key] || { connected: false };
          const notConfigured = state.configured === false;
          const isDisconnecting = connecting === `disconnect-${s.key}`;
          const isConnecting = connecting === s.key;
          return (
            <View key={s.key} style={styles.linkedinCard}>
              <Ionicons name={s.icon} size={22} color={s.color} />
              <View style={{ flex: 1 }}>
                <Text style={styles.linkedinTitle}>
                  {s.label} · {state.connected ? "Connected" : notConfigured ? "Not configured" : "Not connected"}
                </Text>
                <Text style={styles.linkedinDesc}>
                  {notConfigured ? "Add an Auth Config in Composio dashboard." : `Post directly to ${s.label} from result cards.`}
                </Text>
              </View>
              {state.connected ? (
                <TouchableOpacity
                  testID={`settings-${s.key}-disconnect`}
                  style={[styles.smallBtn, styles.smallBtnGhost]}
                  onPress={() => disconnectSocial(s.key)}
                  disabled={isDisconnecting}
                >
                  {isDisconnecting ? <ActivityIndicator color={colors.text} size="small" /> : (
                    <Text style={[styles.smallBtnText, { color: colors.error }]}>Disconnect</Text>
                  )}
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  testID={`settings-${s.key}-connect`}
                  style={[styles.smallBtn, { backgroundColor: s.color }]}
                  onPress={() => connectSocial(s.key)}
                  disabled={isConnecting || notConfigured}
                >
                  {isConnecting ? <ActivityIndicator color="#fff" size="small" /> : (
                    <Text style={styles.smallBtnText}>Connect</Text>
                  )}
                </TouchableOpacity>
              )}
            </View>
          );
        })}

        {/* Sign out */}
        <TouchableOpacity testID="settings-signout" style={styles.signOut} onPress={signOutUser}>
          <Ionicons name="log-out-outline" size={18} color={colors.error} />
          <Text style={styles.signOutText}>Sign out</Text>
        </TouchableOpacity>

        {toast && (
          <View testID="settings-toast" style={styles.toast}>
            <Text style={styles.toastText}>{toast}</Text>
          </View>
        )}
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.lg, paddingBottom: 100, gap: 6 },
  overline: { color: colors.textSubtle, fontSize: 11, fontWeight: "700", letterSpacing: 2.4, textTransform: "uppercase" },
  h1: { fontSize: 28, fontWeight: "800", color: colors.text, letterSpacing: -0.6, marginTop: 4, fontFamily: fonts.heading as string },
  subEmail: { color: colors.textMuted, marginTop: 2 },

  sectionLabel: { color: colors.textSubtle, fontSize: 11, fontWeight: "700", letterSpacing: 2, textTransform: "uppercase", marginTop: spacing.lg, marginBottom: 8 },

  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: spacing.xl, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  sectionHeaderText: { fontSize: 18, fontWeight: "800", color: colors.text, letterSpacing: -0.4 },
  helper: { color: colors.textMuted, fontSize: 13, marginTop: 8, lineHeight: 19 },

  autofillBtn: { backgroundColor: colors.text, paddingVertical: 14, paddingHorizontal: 16, borderRadius: radii.sm, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: spacing.md },
  autofillBtnDisabled: { opacity: 0.5 },
  autofillText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  aiBadge: { backgroundColor: colors.primary, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, marginLeft: 4 },
  aiBadgeText: { color: "#fff", fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  autofillHelper: { color: colors.textMuted, fontSize: 12, marginTop: 6, lineHeight: 17 },

  chipsRow: { gap: 8, paddingRight: spacing.md },
  chip: { paddingHorizontal: 14, height: 36, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  chipActive: { borderColor: colors.primary, backgroundColor: "#EEF2FF" },
  chipText: { color: colors.textMuted, fontWeight: "600", fontSize: 13 },
  chipTextActive: { color: colors.primary },

  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, paddingHorizontal: 14, paddingVertical: 14, fontSize: 15, color: colors.text, backgroundColor: "#fff" },
  textarea: { minHeight: 110, textAlignVertical: "top" },

  uploadBtn: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderColor: colors.border, borderStyle: "dashed", paddingVertical: 16, paddingHorizontal: 14, borderRadius: radii.sm, backgroundColor: colors.surface },
  uploadText: { flex: 1, color: colors.text, fontWeight: "600" },
  uploadHint: { color: colors.textSubtle, fontSize: 11 },

  linkedinCard: { flexDirection: "row", alignItems: "center", gap: 12, padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, backgroundColor: "#fff", marginBottom: 8 },
  linkedinTitle: { fontWeight: "700", color: colors.text },
  linkedinDesc: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  smallBtn: { backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 10, borderRadius: radii.sm },
  smallBtnGhost: { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.border },
  smallBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },

  signOut: { flexDirection: "row", alignItems: "center", gap: 8, justifyContent: "center", marginTop: spacing.xl, padding: 14, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm },
  signOutText: { color: colors.error, fontWeight: "700" },

  toast: { position: "absolute", bottom: 30, left: 0, right: 0, alignItems: "center" },
  toastText: { backgroundColor: colors.black, color: "#fff", paddingHorizontal: 16, paddingVertical: 10, borderRadius: radii.sm, overflow: "hidden", fontWeight: "600" },
});
