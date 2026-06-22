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

export default function Settings() {
  const { user, signOutUser } = useAuth();
  const [profile, setProfile] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [linkedIn, setLinkedIn] = useState<{ connected: boolean }>({ connected: false });
  const [connecting, setConnecting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([api.getProfile(), api.linkedinStatus()]);
      setProfile(p || {});
      setLinkedIn(s || { connected: false });
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

  const connectLinkedIn = async () => {
    setConnecting(true);
    try {
      const res = await api.linkedinConnect();
      if (res?.redirect_url) {
        await WebBrowser.openBrowserAsync(res.redirect_url);
        // Re-fetch after user returns
        const status = await api.linkedinStatus();
        setLinkedIn(status);
      }
    } catch (e: any) {
      setToast("LinkedIn connect failed");
      setTimeout(() => setToast(null), 1500);
    } finally {
      setConnecting(false);
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

        {/* Guidelines paste */}
        <Text style={styles.sectionLabel}>Company guidelines (text)</Text>
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

        {/* LinkedIn via Composio */}
        <Text style={styles.sectionLabel}>LinkedIn integration</Text>
        <View style={styles.linkedinCard}>
          <Ionicons name="logo-linkedin" size={22} color="#0A66C2" />
          <View style={{ flex: 1 }}>
            <Text style={styles.linkedinTitle}>{linkedIn.connected ? "Connected" : "Not connected"}</Text>
            <Text style={styles.linkedinDesc}>Post drafts directly to LinkedIn via Composio.</Text>
          </View>
          <TouchableOpacity
            testID="settings-linkedin-connect"
            style={[styles.smallBtn, linkedIn.connected && styles.smallBtnGhost]}
            onPress={connectLinkedIn}
            disabled={connecting}
          >
            {connecting ? <ActivityIndicator color={linkedIn.connected ? colors.text : "#fff"} /> : (
              <Text style={[styles.smallBtnText, linkedIn.connected && { color: colors.text }]}>
                {linkedIn.connected ? "Reconnect" : "Connect"}
              </Text>
            )}
          </TouchableOpacity>
        </View>

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

  linkedinCard: { flexDirection: "row", alignItems: "center", gap: 12, padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, backgroundColor: "#fff" },
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
