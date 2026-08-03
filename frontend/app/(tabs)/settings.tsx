import { useCallback, useEffect, useState } from "react";
import { View, Text, TextInput, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert, Linking } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as WebBrowser from "expo-web-browser";
import Constants from "expo-constants";
import { router, useFocusEffect } from "expo-router";
import { useAuth } from "@/src/contexts/AuthContext";
import { api } from "@/src/lib/api";
import { colors, fonts, radii, spacing } from "@/src/theme";

const ROLES = ["SDR", "BDR", "AE", "Account Manager", "CSM", "Sales Engineer", "Founder/CEO"];
const INDUSTRIES = ["SaaS", "FinTech", "Healthcare", "Manufacturing", "Education", "E-commerce", "Real Estate", "Marketing"];
const SUPPORT_EMAIL = "team@coolgeek.me";

export default function Settings() {
  const { user, signOutUser, deleteAccount } = useAuth();
  const [profile, setProfile] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [companies, setCompanies] = useState<any[]>([]);
  const [activeCompanyId, setActiveCompanyId] = useState<string | null>(null);
  const [newCompanyMode, setNewCompanyMode] = useState(false);
  const [newCompanyName, setNewCompanyName] = useState("");
  const [savingNewCompany, setSavingNewCompany] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);

  const loadCompanies = useCallback(async () => {
    try {
      const res = await api.listCompanies();
      setCompanies(res.items || []);
      setActiveCompanyId(res.active_id || null);
      // Sync the active company into the form for editing
      if (res.active_id) {
        const active = (res.items || []).find((c: any) => c.id === res.active_id);
        if (active) {
          setProfile((prev: any) => ({
            ...prev,
            company_name: active.name || "",
            company_website: active.website || "",
            company_offerings: active.offerings || "",
            company_value_props: active.value_props || "",
            industry: active.industry || prev?.industry,
            target_audience: active.target_audience || prev?.target_audience,
          }));
        }
      }
    } catch (e) {}
  }, []);

  const load = useCallback(async () => {
    try {
      const p = await api.getProfile();
      setProfile(p || {});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); loadCompanies(); }, [load, loadCompanies]);

  // Refresh companies every time the tab regains focus (e.g. after deleting/editing on detail page)
  useFocusEffect(
    useCallback(() => {
      loadCompanies();
    }, [loadCompanies])
  );

  const save = async (patch: any) => {
    const next = { ...profile, ...patch };
    setProfile(next);
    try {
      await api.updateProfile(patch);
      setToast("Saved");
      setTimeout(() => setToast(null), 1400);
    } catch (e) {
      setToast("Save failed");
      setTimeout(() => setToast(null), 1400);
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

  const onCreateAndOpen = async () => {
    const name = (newCompanyName || "").trim();
    if (!name) {
      setToast("Type a company name first");
      setTimeout(() => setToast(null), 1500);
      return;
    }
    setSavingNewCompany(true);
    try {
      const c = await api.createCompany({ name });
      await api.activateCompany(c.id);
      setNewCompanyName("");
      setNewCompanyMode(false);
      // Refresh in background; navigate immediately
      loadCompanies();
      router.push(`/company/${c.id}`);
    } catch (e: any) {
      setToast(`Add failed: ${(e?.message || "").slice(0, 80)}`);
      setTimeout(() => setToast(null), 2200);
    } finally {
      setSavingNewCompany(false);
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

        {/* Company info section — list-only; tap a card to manage it */}
        <View style={styles.sectionHeader}>
          <Ionicons name="business-outline" size={16} color={colors.primary} />
          <Text style={styles.sectionHeaderText}>Companies</Text>
        </View>
        <Text style={styles.helper}>
          Manage your businesses. The one marked “Active” drives every generation. Tap a card to edit details and link social accounts.
        </Text>

        {companies.length === 0 ? (
          <View style={styles.emptyCompaniesCard}>
            <Ionicons name="business-outline" size={22} color={colors.textSubtle} />
            <Text style={styles.emptyCompaniesText}>No companies yet — add your first one to get started.</Text>
          </View>
        ) : (
          companies.map((c) => {
            const isActive = activeCompanyId === c.id;
            const linked = (c.linked_accounts || {}) as Record<string, string>;
            const linkedPlatforms = ["linkedin", "facebook", "instagram"].filter((p) => !!linked[p]);
            return (
              <TouchableOpacity
                key={c.id}
                testID={`company-card-${c.id}`}
                style={[styles.companyCard, isActive && styles.companyCardActive]}
                onPress={() => router.push(`/company/${c.id}`)}
                activeOpacity={0.85}
              >
                <View style={styles.companyCardIcon}>
                  <Ionicons name="business" size={20} color={isActive ? colors.primary : colors.textMuted} />
                </View>
                <View style={{ flex: 1 }}>
                  <View style={styles.companyCardTitleRow}>
                    <Text style={styles.companyCardName} numberOfLines={1}>{c.name}</Text>
                    {isActive && <Text style={styles.activeBadge}>ACTIVE</Text>}
                  </View>
                  <Text style={styles.companyCardMeta} numberOfLines={1}>
                    {c.website ? c.website : "No website"}
                    {linkedPlatforms.length > 0 ? ` · ${linkedPlatforms.length} social linked` : ""}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color={colors.textSubtle} />
              </TouchableOpacity>
            );
          })
        )}

        {newCompanyMode ? (
          <View style={styles.newCompanyCard}>
            <Text style={styles.newCompanyLabel}>New company</Text>
            <TextInput
              testID="new-company-name-input"
              style={styles.input}
              value={newCompanyName}
              onChangeText={setNewCompanyName}
              placeholder="e.g. Acme Inc."
              placeholderTextColor={colors.textSubtle}
              autoFocus
              onSubmitEditing={() => onCreateAndOpen()}
            />
            <View style={styles.newCompanyBtnRow}>
              <TouchableOpacity
                testID="new-company-cancel"
                style={[styles.newCompanyBtn, styles.newCompanyBtnGhost]}
                onPress={() => { setNewCompanyMode(false); setNewCompanyName(""); }}
                disabled={savingNewCompany}
              >
                <Text style={styles.newCompanyBtnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="new-company-save"
                style={[styles.newCompanyBtn, styles.newCompanyBtnPrimary, (!newCompanyName.trim() || savingNewCompany) && { opacity: 0.5 }]}
                onPress={() => onCreateAndOpen()}
                disabled={!newCompanyName.trim() || savingNewCompany}
              >
                {savingNewCompany ? <ActivityIndicator color="#fff" size="small" /> : (
                  <Text style={styles.newCompanyBtnPrimaryText}>Create & open</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <TouchableOpacity
            testID="add-company-btn"
            style={styles.addCompanyBtn}
            onPress={() => setNewCompanyMode(true)}
            activeOpacity={0.8}
          >
            <Ionicons name="add-circle-outline" size={18} color={colors.primary} />
            <Text style={styles.addCompanyBtnText}>{companies.length === 0 ? "Add your first company" : "Add another company"}</Text>
          </TouchableOpacity>
        )}

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

        {/* Email accounts */}

        {/* Sign out */}
        <TouchableOpacity testID="settings-signout" style={styles.signOut} onPress={signOutUser}>
          <Ionicons name="log-out-outline" size={18} color={colors.error} />
          <Text style={styles.signOutText}>Sign out</Text>
        </TouchableOpacity>

        {/* Legal & Support section */}
        <View style={styles.sectionHeader}>
          <Ionicons name="shield-outline" size={16} color={colors.primary} />
          <Text style={styles.sectionHeaderText}>Legal &amp; support</Text>
        </View>

        <TouchableOpacity
          testID="settings-privacy-policy"
          style={styles.linkRow}
          onPress={() => WebBrowser.openBrowserAsync(api.legalPrivacyUrl())}
          activeOpacity={0.7}
        >
          <Ionicons name="lock-closed-outline" size={18} color={colors.text} />
          <Text style={styles.linkRowText}>Privacy Policy</Text>
          <Ionicons name="open-outline" size={16} color={colors.textSubtle} />
        </TouchableOpacity>

        <TouchableOpacity
          testID="settings-terms"
          style={styles.linkRow}
          onPress={() => WebBrowser.openBrowserAsync(api.legalTermsUrl())}
          activeOpacity={0.7}
        >
          <Ionicons name="document-text-outline" size={18} color={colors.text} />
          <Text style={styles.linkRowText}>Terms of Service</Text>
          <Ionicons name="open-outline" size={16} color={colors.textSubtle} />
        </TouchableOpacity>

        <TouchableOpacity
          testID="settings-contact-support"
          style={styles.linkRow}
          onPress={async () => {
            const url = `mailto:${SUPPORT_EMAIL}?subject=SalesReady%20Support`;
            const supported = await Linking.canOpenURL(url);
            if (supported) {
              await Linking.openURL(url);
            } else {
              setToast(`Email us at ${SUPPORT_EMAIL}`);
              setTimeout(() => setToast(null), 3500);
            }
          }}
          activeOpacity={0.7}
        >
          <Ionicons name="mail-outline" size={18} color={colors.text} />
          <View style={{ flex: 1 }}>
            <Text style={styles.linkRowText}>Contact support</Text>
            <Text style={styles.linkRowSub}>{SUPPORT_EMAIL}</Text>
          </View>
          <Ionicons name="open-outline" size={16} color={colors.textSubtle} />
        </TouchableOpacity>

        {/* Delete account — destructive, always last */}
        <TouchableOpacity
          testID="settings-delete-account"
          style={styles.deleteRow}
          disabled={deletingAccount}
          onPress={() => {
            Alert.alert(
              "Delete your account?",
              "This permanently deletes your account, all companies, saved history, scheduled posts, and connected social accounts. This cannot be undone.",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Delete",
                  style: "destructive",
                  onPress: async () => {
                    try {
                      setDeletingAccount(true);
                      await deleteAccount();
                      // Firebase auth state change will route back to sign-in automatically.
                    } catch (e: any) {
                      const msg = String(e?.message || e || "");
                      if (msg.includes("auth/requires-recent-login")) {
                        Alert.alert(
                          "Please sign in again",
                          "For security, deleting an account requires a fresh sign-in. Sign out, sign back in, then try again.",
                        );
                      } else {
                        Alert.alert("Couldn't delete account", msg.slice(0, 240) || "Please try again or email team@coolgeek.me.");
                      }
                    } finally {
                      setDeletingAccount(false);
                    }
                  },
                },
              ],
            );
          }}
          activeOpacity={0.8}
        >
          {deletingAccount ? (
            <ActivityIndicator size="small" color={colors.error} />
          ) : (
            <Ionicons name="trash-outline" size={18} color={colors.error} />
          )}
          <Text style={styles.deleteRowText}>{deletingAccount ? "Deleting…" : "Delete my account"}</Text>
        </TouchableOpacity>

        {/* Admin shortcut (only visible to admins) */}
        {profile.is_admin && (
          <TouchableOpacity
            testID="settings-admin-link"
            style={styles.adminLink}
            onPress={() => router.push("/admin")}
            activeOpacity={0.85}
          >
            <Ionicons name="shield-checkmark" size={18} color="#7c3aed" />
            <View style={{ flex: 1 }}>
              <Text style={styles.adminLinkTitle}>Admin · Comps</Text>
              <Text style={styles.adminLinkDesc}>Grant free Pro access to friends &amp; family</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textSubtle} />
          </TouchableOpacity>
        )}

        {/* Version footer */}
        <View testID="settings-version" style={styles.versionFooter}>
          <Text style={styles.versionAppName}>SalesReady</Text>
          <Text style={styles.versionLine}>
            v{Constants.expoConfig?.version || "1.0.0"} ({Constants.nativeBuildVersion || "—"}) · OTA {((Constants.expoConfig as any)?.updates?.runtimeVersion || Constants.expoConfig?.runtimeVersion || "dev")}
          </Text>
          <Text style={styles.versionMeta}>{Constants.expoConfig?.sdkVersion ? `Expo SDK ${Constants.expoConfig.sdkVersion}` : ""}{Constants.executionEnvironment ? ` · ${Constants.executionEnvironment}` : ""}</Text>
        </View>

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
  chip: { paddingHorizontal: 14, height: 36, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", flexShrink: 0, maxWidth: 200 },
  chipActive: { borderColor: colors.primary, backgroundColor: "#EEF2FF" },
  chipText: { color: colors.textMuted, fontWeight: "600", fontSize: 13 },
  chipTextActive: { color: colors.primary },

  emptyCompaniesCard: { flexDirection: "row", alignItems: "center", gap: 10, padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderStyle: "dashed", borderRadius: radii.sm, backgroundColor: colors.surface, marginTop: 8 },
  emptyCompaniesText: { color: colors.textMuted, fontSize: 13, flex: 1 },

  companyCard: { flexDirection: "row", alignItems: "center", gap: 12, padding: spacing.md, marginTop: 8, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: "#fff" },
  companyCardActive: { borderColor: colors.primary, backgroundColor: "#EEF2FF" },
  companyCardIcon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  companyCardTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  companyCardName: { color: colors.text, fontWeight: "700", fontSize: 15, flexShrink: 1 },
  companyCardMeta: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  activeBadge: { color: colors.primary, fontSize: 10, fontWeight: "800", letterSpacing: 1.4, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: "#fff", borderWidth: 1, borderColor: colors.primary, overflow: "hidden" },
  addCompanyBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14, marginTop: 10, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.primary, borderStyle: "dashed", backgroundColor: "#EEF2FF" },
  addCompanyBtnText: { color: colors.primary, fontWeight: "700", fontSize: 14 },

  newCompanyCard: { marginTop: 10, padding: spacing.md, borderWidth: 1, borderColor: colors.primary, borderRadius: radii.sm, backgroundColor: "#fff", gap: 10 },
  newCompanyLabel: { color: colors.textSubtle, fontSize: 11, fontWeight: "700", letterSpacing: 2, textTransform: "uppercase" },
  newCompanyBtnRow: { flexDirection: "row", gap: 8, justifyContent: "flex-end" },
  newCompanyBtn: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: radii.sm, alignItems: "center", justifyContent: "center", minWidth: 88 },
  newCompanyBtnPrimary: { backgroundColor: colors.primary },
  newCompanyBtnPrimaryText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  newCompanyBtnGhost: { borderWidth: 1, borderColor: colors.border, backgroundColor: "transparent" },
  newCompanyBtnGhostText: { color: colors.text, fontWeight: "600", fontSize: 14 },
  deleteConfirmBtn: { backgroundColor: colors.error },

  editingBanner: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 12, paddingHorizontal: spacing.md, paddingVertical: 10, borderRadius: radii.sm, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  editingLabel: { color: colors.textSubtle, fontSize: 10, fontWeight: "700", letterSpacing: 1.8, textTransform: "uppercase" },
  editingName: { color: colors.text, fontWeight: "700", fontSize: 14, marginTop: 2 },
  deleteCompanyBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: radii.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: "#fff" },

  confirmCard: { marginTop: 10, padding: spacing.md, borderWidth: 1, borderColor: colors.error, borderRadius: radii.sm, backgroundColor: "#FEF2F2", gap: 8 },
  confirmTitle: { color: colors.text, fontWeight: "800", fontSize: 15 },
  confirmDesc: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },

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
  accountHint: { color: colors.textSubtle, fontSize: 12, paddingHorizontal: spacing.md, paddingBottom: spacing.md, fontStyle: "italic" },

  signOut: { flexDirection: "row", alignItems: "center", gap: 8, justifyContent: "center", marginTop: spacing.xl, padding: 14, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm },
  signOutText: { color: colors.error, fontWeight: "700" },

  linkRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, paddingHorizontal: 14, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, backgroundColor: "#fff", marginTop: 8 },
  linkRowText: { flex: 1, color: colors.text, fontWeight: "600", fontSize: 14 },
  linkRowSub: { color: colors.textSubtle, fontSize: 11, marginTop: 2 },

  deleteRow: { flexDirection: "row", alignItems: "center", gap: 10, justifyContent: "center", marginTop: 10, padding: 14, borderWidth: 1, borderColor: colors.error, borderRadius: radii.sm, backgroundColor: "#FEF2F2" },
  deleteRowText: { color: colors.error, fontWeight: "800", fontSize: 14 },

  adminLink: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 10, padding: 14, borderRadius: radii.sm, borderWidth: 1, borderColor: "#7c3aed", backgroundColor: "#F3E8FF" },
  adminLinkTitle: { color: "#7c3aed", fontWeight: "800", fontSize: 14 },
  adminLinkDesc: { color: colors.textMuted, fontSize: 11, marginTop: 2 },

  versionFooter: { alignItems: "center", marginTop: spacing.xl, paddingVertical: spacing.md, paddingHorizontal: spacing.md, gap: 2 },
  versionAppName: { color: colors.textSubtle, fontSize: 11, fontWeight: "800", letterSpacing: 2 },
  versionLine: { color: colors.textMuted, fontSize: 11, fontWeight: "600", marginTop: 2 },
  versionMeta: { color: colors.textSubtle, fontSize: 10, marginTop: 2 },

  toast: { position: "absolute", bottom: 30, left: 0, right: 0, alignItems: "center" },
  toastText: { backgroundColor: colors.black, color: "#fff", paddingHorizontal: 16, paddingVertical: 10, borderRadius: radii.sm, overflow: "hidden", fontWeight: "600" },
});
