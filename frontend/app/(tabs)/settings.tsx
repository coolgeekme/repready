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
type SocialAccount = { id: string; status?: string; display_name?: string; created_at?: string };
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
  const [companies, setCompanies] = useState<any[]>([]);
  const [activeCompanyId, setActiveCompanyId] = useState<string | null>(null);
  const [accountsByPlatform, setAccountsByPlatform] = useState<Record<string, SocialAccount[]>>({});
  const [linkBusy, setLinkBusy] = useState<string | null>(null);
  const [newCompanyMode, setNewCompanyMode] = useState(false);
  const [newCompanyName, setNewCompanyName] = useState("");
  const [savingNewCompany, setSavingNewCompany] = useState(false);
  const [deletingCompanyId, setDeletingCompanyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const activeCompany = companies.find((c) => c.id === activeCompanyId);
  const linkedFor = (platform: string): string | null =>
    (activeCompany?.linked_accounts && activeCompany.linked_accounts[platform]) || null;

  const refreshAccounts = useCallback(async (platform: string) => {
    try {
      const res = await api.socialAccounts(platform);
      setAccountsByPlatform((m) => ({ ...m, [platform]: res.accounts || [] }));
    } catch (e) {
      setAccountsByPlatform((m) => ({ ...m, [platform]: [] }));
    }
  }, []);

  const refreshAllAccounts = useCallback(async () => {
    await Promise.all(SOCIALS.map((s) => refreshAccounts(s.key)));
  }, [refreshAccounts]);

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

  // Save changes to the company record (or fall back to profile if no active company)
  const saveCompanyField = async (patch: any) => {
    setProfile((p: any) => ({ ...p, ...patch }));
    try {
      if (activeCompanyId) {
        const mapped: any = {};
        if (patch.company_name !== undefined) mapped.name = patch.company_name;
        if (patch.company_website !== undefined) mapped.website = patch.company_website;
        if (patch.company_offerings !== undefined) mapped.offerings = patch.company_offerings;
        if (patch.company_value_props !== undefined) mapped.value_props = patch.company_value_props;
        if (patch.industry !== undefined) mapped.industry = patch.industry;
        if (patch.target_audience !== undefined) mapped.target_audience = patch.target_audience;
        if (Object.keys(mapped).length > 0) {
          // Need the company name to be present for the schema
          const current = companies.find((c) => c.id === activeCompanyId) || {};
          mapped.name = mapped.name ?? current.name ?? "";
          if (!mapped.name) return; // can't save without a name
          await api.updateCompany(activeCompanyId, mapped);
          await loadCompanies();
        }
      } else {
        await api.updateProfile(patch);
      }
      setToast("Saved");
      setTimeout(() => setToast(null), 1200);
    } catch (e) {
      setToast("Save failed");
      setTimeout(() => setToast(null), 1500);
    }
  };

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

  useEffect(() => { load(); loadCompanies(); refreshAllAccounts(); }, [load, loadCompanies, refreshAllAccounts]);

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
      // Refresh status & accounts after returning
      const s = await api.socialStatus(platform);
      setSocials((m) => ({ ...m, [platform]: s }));
      await refreshAccounts(platform);
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
      await refreshAccounts(platform);
      await loadCompanies();
    } catch (e: any) {
      setToast(`${platform} disconnect failed`);
      setTimeout(() => setToast(null), 2000);
    } finally {
      setConnecting(null);
    }
  };

  const deleteAccount = async (platform: "linkedin" | "facebook" | "instagram", accountId: string) => {
    setLinkBusy(`delete-${platform}-${accountId}`);
    try {
      await api.deleteSocialAccount(platform, accountId);
      await refreshAccounts(platform);
      const s = await api.socialStatus(platform);
      setSocials((m) => ({ ...m, [platform]: s }));
      await loadCompanies();
      setToast("Account removed");
      setTimeout(() => setToast(null), 1500);
    } catch (e: any) {
      setToast("Remove failed");
      setTimeout(() => setToast(null), 1800);
    } finally {
      setLinkBusy(null);
    }
  };

  const linkAccount = async (platform: "linkedin" | "facebook" | "instagram", accountId: string | null) => {
    if (!activeCompanyId) {
      setToast("Pick an active company first");
      setTimeout(() => setToast(null), 1500);
      return;
    }
    setLinkBusy(`link-${platform}-${accountId || "none"}`);
    try {
      await api.linkAccountToCompany(activeCompanyId, platform, accountId);
      await loadCompanies();
      setToast(accountId ? `${platform} linked` : `${platform} unlinked`);
      setTimeout(() => setToast(null), 1500);
    } catch (e: any) {
      setToast("Link failed");
      setTimeout(() => setToast(null), 1800);
    } finally {
      setLinkBusy(null);
    }
  };

  const activateCompany = async (id: string) => {
    try {
      await api.activateCompany(id);
      setActiveCompanyId(id);
      const c = companies.find((x) => x.id === id);
      if (c) {
        setProfile((p: any) => ({
          ...p,
          company_name: c.name || "",
          company_website: c.website || "",
          company_offerings: c.offerings || "",
          company_value_props: c.value_props || "",
          industry: c.industry || p?.industry,
          target_audience: c.target_audience || p?.target_audience,
        }));
      }
      setToast("Active company switched");
      setTimeout(() => setToast(null), 1500);
    } catch (e) {
      setToast("Switch failed");
      setTimeout(() => setToast(null), 1500);
    }
  };

  const addCompany = async (nameArg?: string) => {
    const name = (nameArg ?? newCompanyName ?? "").trim();
    if (!name) {
      setToast("Type a company name first");
      setTimeout(() => setToast(null), 1500);
      return;
    }
    setSavingNewCompany(true);
    try {
      const c = await api.createCompany({ name });
      // Activate it server-side
      await api.activateCompany(c.id);
      // Refresh state from server
      await loadCompanies();
      // Reset the new-company inline form & switch the editing form to the newly active company
      setNewCompanyName("");
      setNewCompanyMode(false);
      setProfile((p: any) => ({
        ...p,
        company_name: c.name || "",
        company_website: "",
        company_offerings: "",
        company_value_props: "",
        target_audience: p?.target_audience || "",
      }));
      setToast(`Added ${c.name}`);
      setTimeout(() => setToast(null), 1500);
    } catch (e: any) {
      setToast(`Add failed: ${(e?.message || "").slice(0, 80)}`);
      setTimeout(() => setToast(null), 2200);
    } finally {
      setSavingNewCompany(false);
    }
  };

  const removeCompany = async (companyId: string) => {
    setDeletingCompanyId(companyId);
    try {
      await api.deleteCompany(companyId);
      // Refresh and pick the next active company from the refreshed list
      const res = await api.listCompanies();
      setCompanies(res.items || []);
      const newActiveId = res.active_id || null;
      setActiveCompanyId(newActiveId);
      const next = (res.items || []).find((c: any) => c.id === newActiveId);
      setProfile((p: any) => ({
        ...p,
        company_name: next?.name || "",
        company_website: next?.website || "",
        company_offerings: next?.offerings || "",
        company_value_props: next?.value_props || "",
        industry: next?.industry || p?.industry,
        target_audience: next?.target_audience || p?.target_audience,
      }));
      setConfirmDeleteId(null);
      setToast("Company removed");
      setTimeout(() => setToast(null), 1500);
    } catch (e: any) {
      setToast(`Delete failed: ${(e?.message || "").slice(0, 80)}`);
      setTimeout(() => setToast(null), 2200);
    } finally {
      setDeletingCompanyId(null);
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
      // Persist to the active company (or profile fallback) — uses single source of truth
      if (activeCompanyId) {
        const current = companies.find((c) => c.id === activeCompanyId);
        await api.updateCompany(activeCompanyId, {
          name: current?.name || profile.company_name,
          website: profile.company_website,
          offerings: patch.company_offerings,
          value_props: patch.company_value_props,
          industry: patch.industry,
          target_audience: patch.target_audience,
        });
        await loadCompanies();
      } else {
        await api.updateProfile(patch);
      }
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
          <Text style={styles.sectionHeaderText}>Companies</Text>
        </View>
        <Text style={styles.helper}>Switch between businesses. The active one drives every generation.</Text>

        {/* Companies list — always shown, including empty state */}
        {companies.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
            {companies.map((c) => {
              const isActive = activeCompanyId === c.id;
              return (
                <TouchableOpacity
                  key={c.id}
                  testID={`company-chip-${c.id}`}
                  onPress={() => activateCompany(c.id)}
                  onLongPress={() => setConfirmDeleteId(c.id)}
                  style={[styles.chip, isActive && styles.chipActive]}
                >
                  <Text style={[styles.chipText, isActive && styles.chipTextActive]} numberOfLines={1}>{c.name}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        ) : (
          <View style={styles.emptyCompaniesCard}>
            <Ionicons name="business-outline" size={20} color={colors.textSubtle} />
            <Text style={styles.emptyCompaniesText}>No companies yet — add your first one below.</Text>
          </View>
        )}

        {/* Inline new-company form */}
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
              onSubmitEditing={() => addCompany()}
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
                onPress={() => addCompany()}
                disabled={!newCompanyName.trim() || savingNewCompany}
              >
                {savingNewCompany ? <ActivityIndicator color="#fff" size="small" /> : (
                  <Text style={styles.newCompanyBtnPrimaryText}>Create</Text>
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

        {activeCompanyId && activeCompany && (
          <View style={styles.editingBanner}>
            <View style={{ flex: 1 }}>
              <Text style={styles.editingLabel}>Editing</Text>
              <Text style={styles.editingName} numberOfLines={1}>{activeCompany.name}</Text>
            </View>
            <TouchableOpacity
              testID={`delete-company-${activeCompanyId}`}
              style={styles.deleteCompanyBtn}
              onPress={() => setConfirmDeleteId(activeCompanyId)}
              hitSlop={6}
            >
              <Ionicons name="trash-outline" size={18} color={colors.error} />
            </TouchableOpacity>
          </View>
        )}

        {/* Confirm delete dialog (inline) */}
        {confirmDeleteId && (
          <View style={styles.confirmCard}>
            <Text style={styles.confirmTitle}>Delete this company?</Text>
            <Text style={styles.confirmDesc}>
              “{companies.find((c) => c.id === confirmDeleteId)?.name || "this company"}” will be removed. Past generations stay in your library.
            </Text>
            <View style={styles.newCompanyBtnRow}>
              <TouchableOpacity
                testID="confirm-delete-cancel"
                style={[styles.newCompanyBtn, styles.newCompanyBtnGhost]}
                onPress={() => setConfirmDeleteId(null)}
                disabled={!!deletingCompanyId}
              >
                <Text style={styles.newCompanyBtnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="confirm-delete-confirm"
                style={[styles.newCompanyBtn, styles.deleteConfirmBtn]}
                onPress={() => removeCompany(confirmDeleteId)}
                disabled={!!deletingCompanyId}
              >
                {deletingCompanyId ? <ActivityIndicator color="#fff" size="small" /> : (
                  <Text style={styles.newCompanyBtnPrimaryText}>Delete</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}

        <Text style={styles.sectionLabel}>Company name</Text>
        <TextInput
          testID="settings-company-name"
          style={[styles.input, !activeCompanyId && { opacity: 0.5 }]}
          value={profile.company_name || ""}
          onChangeText={(t) => setProfile({ ...profile, company_name: t })}
          onBlur={() => saveCompanyField({ company_name: profile.company_name || "" })}
          placeholder={activeCompanyId ? "Acme Inc." : "Create a company above first"}
          placeholderTextColor={colors.textSubtle}
          editable={!!activeCompanyId}
        />

        <Text style={styles.sectionLabel}>Website (optional, recommended)</Text>
        <TextInput
          testID="settings-company-website"
          style={[styles.input, !activeCompanyId && { opacity: 0.5 }]}
          value={profile.company_website || ""}
          onChangeText={(t) => setProfile({ ...profile, company_website: t })}
          onBlur={() => saveCompanyField({ company_website: profile.company_website || "" })}
          placeholder="acme.com"
          placeholderTextColor={colors.textSubtle}
          autoCapitalize="none"
          keyboardType="url"
          editable={!!activeCompanyId}
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
          onBlur={() => saveCompanyField({ company_offerings: profile.company_offerings || "" })}
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
          onBlur={() => saveCompanyField({ company_value_props: profile.company_value_props || "" })}
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
        <Text style={styles.helper}>
          Connect one or more accounts per network. The radio button picks which account
          {activeCompany?.name ? ` "${activeCompany.name}"` : " the active company"} uses when posting.
        </Text>

        {SOCIALS.map((s) => {
          const state = socials[s.key] || { connected: false };
          const notConfigured = state.configured === false;
          const isConnecting = connecting === s.key;
          const accounts = accountsByPlatform[s.key] || [];
          const linkedId = linkedFor(s.key);
          const activeAccounts = accounts.filter((a) => a.status === "ACTIVE" || !a.status);
          return (
            <View key={s.key} style={styles.platformBlock}>
              <View style={styles.platformHeader}>
                <Ionicons name={s.icon} size={22} color={s.color} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.platformTitle}>{s.label}</Text>
                  <Text style={styles.platformSubtitle}>
                    {notConfigured
                      ? "Not configured in backend"
                      : activeAccounts.length === 0
                      ? "No accounts connected yet"
                      : `${activeAccounts.length} account${activeAccounts.length === 1 ? "" : "s"} connected`}
                  </Text>
                </View>
                <TouchableOpacity
                  testID={`settings-${s.key}-connect`}
                  style={[styles.smallBtn, { backgroundColor: s.color }, notConfigured && { opacity: 0.5 }]}
                  onPress={() => connectSocial(s.key)}
                  disabled={isConnecting || notConfigured}
                >
                  {isConnecting ? <ActivityIndicator color="#fff" size="small" /> : (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                      <Ionicons name="add" size={14} color="#fff" />
                      <Text style={styles.smallBtnText}>{activeAccounts.length === 0 ? "Connect" : "Add"}</Text>
                    </View>
                  )}
                </TouchableOpacity>
              </View>

              {activeAccounts.length > 0 && (
                <View style={styles.accountsList}>
                  {activeAccounts.map((a) => {
                    const isLinked = linkedId === a.id;
                    const linkKey = `link-${s.key}-${a.id}`;
                    const delKey = `delete-${s.key}-${a.id}`;
                    const linking = linkBusy === linkKey || linkBusy === `link-${s.key}-none`;
                    const deleting = linkBusy === delKey;
                    return (
                      <View key={a.id} style={styles.accountRow}>
                        <TouchableOpacity
                          testID={`account-link-${s.key}-${a.id}`}
                          style={styles.radioWrap}
                          onPress={() => linkAccount(s.key, isLinked ? null : a.id)}
                          disabled={linking || !activeCompanyId}
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
                            {isLinked
                              ? `Used by ${activeCompany?.name || "active company"}`
                              : a.status === "ACTIVE" ? "Active" : (a.status || "Connected")}
                          </Text>
                        </View>
                        <TouchableOpacity
                          testID={`account-delete-${s.key}-${a.id}`}
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

              {accounts.length === 0 && !notConfigured && state.connected === false && (
                <Text style={styles.accountHint}>Tap “Connect” to authorise your first {s.label} account.</Text>
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
  chip: { paddingHorizontal: 14, height: 36, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", flexShrink: 0, maxWidth: 200 },
  chipActive: { borderColor: colors.primary, backgroundColor: "#EEF2FF" },
  chipText: { color: colors.textMuted, fontWeight: "600", fontSize: 13 },
  chipTextActive: { color: colors.primary },

  emptyCompaniesCard: { flexDirection: "row", alignItems: "center", gap: 10, padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderStyle: "dashed", borderRadius: radii.sm, backgroundColor: colors.surface, marginTop: 8 },
  emptyCompaniesText: { color: colors.textMuted, fontSize: 13, flex: 1 },

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

  toast: { position: "absolute", bottom: 30, left: 0, right: 0, alignItems: "center" },
  toastText: { backgroundColor: colors.black, color: "#fff", paddingHorizontal: 16, paddingVertical: 10, borderRadius: radii.sm, overflow: "hidden", fontWeight: "600" },
});
