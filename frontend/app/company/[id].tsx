import { useCallback, useEffect, useState } from "react";
import { View, Text, TextInput, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams, Stack } from "expo-router";
import { api } from "@/src/lib/api";
import { colors, fonts, radii, spacing } from "@/src/theme";
import CompanySocialsSection from "@/src/components/CompanySocialsSection";

const INDUSTRIES = ["SaaS", "FinTech", "Healthcare", "Manufacturing", "Education", "E-commerce", "Real Estate", "Marketing"];

export default function CompanyDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [company, setCompany] = useState<any>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoFilling, setAutoFilling] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [savingActive, setSavingActive] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((m: string, ms = 1800) => {
    setToast(m);
    setTimeout(() => setToast(null), ms);
  }, []);

  const loadCompany = useCallback(async () => {
    try {
      const res = await api.listCompanies();
      setActiveId(res.active_id || null);
      const c = (res.items || []).find((x: any) => x.id === id);
      if (!c) {
        showToast("Company not found");
        setTimeout(() => router.back(), 800);
        return;
      }
      setCompany(c);
    } catch (e: any) {
      showToast("Failed to load");
    } finally {
      setLoading(false);
    }
  }, [id, showToast]);

  useEffect(() => { loadCompany(); }, [loadCompany]);

  const updateField = async (patch: Record<string, any>) => {
    if (!company) return;
    // Optimistic local update
    const merged = { ...company, ...patch };
    setCompany(merged);
    try {
      await api.updateCompany(company.id, {
        name: merged.name || company.name,
        website: merged.website ?? undefined,
        offerings: merged.offerings ?? undefined,
        value_props: merged.value_props ?? undefined,
        industry: merged.industry ?? undefined,
        target_audience: merged.target_audience ?? undefined,
      });
    } catch (e: any) {
      showToast(`Save failed: ${(e?.message || "").slice(0, 80)}`);
    }
  };

  const setActive = async () => {
    if (!company || activeId === company.id) return;
    setSavingActive(true);
    try {
      await api.activateCompany(company.id);
      setActiveId(company.id);
      showToast(`${company.name} is now the active company`);
    } catch (e: any) {
      showToast("Failed to set active");
    } finally {
      setSavingActive(false);
    }
  };

  const autofill = async () => {
    if (!company?.name?.trim()) {
      showToast("Company name required");
      return;
    }
    setAutoFilling(true);
    showToast(`Researching ${company.name}… (5-15s)`);
    try {
      const res = await api.companyAutofill(company.name.trim(), company.website);
      const merged = {
        ...company,
        offerings: res.company_offerings || company.offerings || "",
        value_props: res.company_value_props || company.value_props || "",
        industry: res.industry || company.industry,
        target_audience: res.target_audience || company.target_audience,
      };
      setCompany(merged);
      await api.updateCompany(company.id, {
        name: merged.name,
        website: merged.website || undefined,
        offerings: merged.offerings || undefined,
        value_props: merged.value_props || undefined,
        industry: merged.industry || undefined,
        target_audience: merged.target_audience || undefined,
      });
      showToast(res.fetched_site ? "✓ Auto-filled from site" : "✓ Auto-filled (no site reached)", 2200);
    } catch (e: any) {
      const msg = (e?.message || "").slice(0, 120);
      showToast(`Auto-fill failed: ${msg}`, 4000);
    } finally {
      setAutoFilling(false);
    }
  };

  const remove = async () => {
    if (!company) return;
    setDeleting(true);
    try {
      await api.deleteCompany(company.id);
      showToast("Company removed");
      setTimeout(() => router.back(), 400);
    } catch (e: any) {
      showToast(`Delete failed: ${(e?.message || "").slice(0, 80)}`);
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (!company) return null;

  const isActive = activeId === company.id;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity testID="company-back" style={styles.iconBtn} onPress={() => router.back()} hitSlop={8}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>{company.name}</Text>
          {isActive && <Text style={styles.activeBadge}>ACTIVE</Text>}
        </View>
        <TouchableOpacity testID="company-delete" style={[styles.iconBtn, { borderColor: colors.error }]} onPress={() => setConfirmDelete(true)} hitSlop={8}>
          <Ionicons name="trash-outline" size={20} color={colors.error} />
        </TouchableOpacity>
      </View>

      <KeyboardAwareScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {!isActive && (
          <TouchableOpacity
            testID="company-set-active"
            style={styles.setActiveBtn}
            onPress={setActive}
            disabled={savingActive}
            activeOpacity={0.85}
          >
            {savingActive ? <ActivityIndicator color="#fff" /> : (
              <>
                <Ionicons name="star-outline" size={16} color="#fff" />
                <Text style={styles.setActiveBtnText}>Use this company for new generations</Text>
              </>
            )}
          </TouchableOpacity>
        )}

        <Text style={styles.sectionLabel}>Company name</Text>
        <TextInput
          testID="company-name-input"
          style={styles.input}
          value={company.name || ""}
          onChangeText={(t) => setCompany({ ...company, name: t })}
          onBlur={() => updateField({ name: company.name })}
          placeholder="Acme Inc."
          placeholderTextColor={colors.textSubtle}
        />

        <Text style={styles.sectionLabel}>Website</Text>
        <TextInput
          testID="company-website-input"
          style={styles.input}
          value={company.website || ""}
          onChangeText={(t) => setCompany({ ...company, website: t })}
          onBlur={() => updateField({ website: company.website })}
          placeholder="acme.com"
          placeholderTextColor={colors.textSubtle}
          autoCapitalize="none"
          keyboardType="url"
        />

        <TouchableOpacity
          testID="company-autofill"
          style={[styles.autofillBtn, autoFilling && { opacity: 0.65 }]}
          onPress={autofill}
          disabled={autoFilling || !company.name?.trim()}
        >
          {autoFilling ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <View style={styles.autofillInner}>
              <Ionicons name="sparkles" size={18} color="#fff" />
              <Text style={styles.autofillText}>Auto-fill with AI</Text>
              <View style={styles.autofillBadge}><Text style={styles.autofillBadgeText}>AI</Text></View>
            </View>
          )}
        </TouchableOpacity>
        {autoFilling && <Text style={styles.autofillHint}>Researching {company.name}… up to 15s</Text>}
        <Text style={styles.helper}>Reads your website and fills offerings, value props, industry & ICP.</Text>

        <Text style={styles.sectionLabel}>What does your company sell?</Text>
        <TextInput
          testID="company-offerings-input"
          style={[styles.input, styles.textarea]}
          value={company.offerings || ""}
          onChangeText={(t) => setCompany({ ...company, offerings: t })}
          onBlur={() => updateField({ offerings: company.offerings })}
          placeholder="Describe your product/service in 2-4 sentences. Who it's for, what it does, how it's delivered."
          placeholderTextColor={colors.textSubtle}
          multiline
        />

        <Text style={styles.sectionLabel}>Key value props / differentiators (optional)</Text>
        <TextInput
          testID="company-value-props-input"
          style={[styles.input, styles.textarea]}
          value={company.value_props || ""}
          onChangeText={(t) => setCompany({ ...company, value_props: t })}
          onBlur={() => updateField({ value_props: company.value_props })}
          placeholder={"• 40% faster onboarding\n• SOC 2 compliant\n• Only solution with native Salesforce sync"}
          placeholderTextColor={colors.textSubtle}
          multiline
        />

        <Text style={styles.sectionLabel}>Industry</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
          {INDUSTRIES.map((r) => (
            <TouchableOpacity
              key={r}
              testID={`company-industry-${r}`}
              onPress={() => updateField({ industry: r })}
              style={[styles.chip, company.industry === r && styles.chipActive]}
            >
              <Text style={[styles.chipText, company.industry === r && styles.chipTextActive]}>{r}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <Text style={styles.sectionLabel}>Target audience</Text>
        <TextInput
          testID="company-target-input"
          style={styles.input}
          value={company.target_audience || ""}
          onChangeText={(t) => setCompany({ ...company, target_audience: t })}
          onBlur={() => updateField({ target_audience: company.target_audience })}
          placeholder="VPs of Engineering at mid-market SaaS"
          placeholderTextColor={colors.textSubtle}
        />

        <View style={styles.sectionHeader}>
          <Ionicons name="share-social-outline" size={16} color={colors.primary} />
          <Text style={styles.sectionHeaderText}>Linked social accounts</Text>
        </View>
        <CompanySocialsSection
          companyId={company.id}
          companyName={company.name}
          linkedAccounts={company.linked_accounts || {}}
          onChange={loadCompany}
          onToast={showToast}
        />

        <View style={{ height: 80 }} />
      </KeyboardAwareScrollView>

      {confirmDelete && (
        <View style={styles.overlay}>
          <View style={styles.confirmCard}>
            <Text style={styles.confirmTitle}>Delete {company.name}?</Text>
            <Text style={styles.confirmDesc}>
              Past generations stay in your library. Linked social accounts stay connected at the account level.
            </Text>
            <View style={styles.confirmBtnRow}>
              <TouchableOpacity
                testID="confirm-cancel"
                style={[styles.confirmBtn, styles.confirmBtnGhost]}
                onPress={() => setConfirmDelete(false)}
                disabled={deleting}
              >
                <Text style={styles.confirmBtnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="confirm-delete"
                style={[styles.confirmBtn, styles.confirmBtnDanger]}
                onPress={remove}
                disabled={deleting}
              >
                {deleting ? <ActivityIndicator color="#fff" /> : <Text style={styles.confirmBtnDangerText}>Delete</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {toast && (
        <View testID="company-toast" style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.md, paddingVertical: 12, gap: 12, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: "#fff" },
  iconBtn: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: radii.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: "#fff" },
  title: { color: colors.text, fontSize: 17, fontWeight: "800", fontFamily: fonts.bold },
  activeBadge: { color: colors.primary, fontSize: 10, fontWeight: "800", letterSpacing: 1.5, marginTop: 2 },
  scroll: { padding: spacing.md, paddingBottom: 60 },

  setActiveBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14, borderRadius: radii.sm, backgroundColor: colors.primary, marginBottom: 16 },
  setActiveBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },

  sectionLabel: { color: colors.textSubtle, fontSize: 11, fontWeight: "700", letterSpacing: 1.5, textTransform: "uppercase", marginTop: 16, marginBottom: 6 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, backgroundColor: "#fff", paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: colors.text },
  textarea: { minHeight: 96, textAlignVertical: "top" },
  helper: { color: colors.textMuted, fontSize: 12, marginTop: 6, lineHeight: 16 },

  autofillBtn: { backgroundColor: colors.primary, paddingVertical: 14, borderRadius: radii.sm, marginTop: 12, alignItems: "center", justifyContent: "center" },
  autofillInner: { flexDirection: "row", alignItems: "center", gap: 8 },
  autofillText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  autofillBadge: { backgroundColor: "rgba(255,255,255,0.25)", borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, marginLeft: 4 },
  autofillBadgeText: { color: "#fff", fontWeight: "800", fontSize: 10, letterSpacing: 1 },
  autofillHint: { color: colors.primary, fontSize: 12, fontWeight: "600", marginTop: 6, textAlign: "center" },

  chipsRow: { gap: 8, paddingRight: spacing.md },
  chip: { paddingHorizontal: 14, height: 36, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", flexShrink: 0, backgroundColor: "#fff" },
  chipActive: { borderColor: colors.primary, backgroundColor: "#EEF2FF" },
  chipText: { color: colors.textMuted, fontWeight: "600", fontSize: 13 },
  chipTextActive: { color: colors.primary },

  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 24, marginBottom: 8 },
  sectionHeaderText: { color: colors.text, fontWeight: "800", fontSize: 16 },

  overlay: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center", padding: spacing.md },
  confirmCard: { backgroundColor: "#fff", padding: spacing.lg, borderRadius: radii.md, width: "100%", maxWidth: 380, gap: 10 },
  confirmTitle: { color: colors.text, fontWeight: "800", fontSize: 17 },
  confirmDesc: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  confirmBtnRow: { flexDirection: "row", gap: 8, justifyContent: "flex-end", marginTop: 6 },
  confirmBtn: { paddingHorizontal: 18, paddingVertical: 11, borderRadius: radii.sm, alignItems: "center", justifyContent: "center", minWidth: 90 },
  confirmBtnGhost: { borderWidth: 1, borderColor: colors.border, backgroundColor: "transparent" },
  confirmBtnGhostText: { color: colors.text, fontWeight: "600", fontSize: 14 },
  confirmBtnDanger: { backgroundColor: colors.error },
  confirmBtnDangerText: { color: "#fff", fontWeight: "700", fontSize: 14 },

  toast: { position: "absolute", left: 16, right: 16, bottom: 32, backgroundColor: colors.text, paddingHorizontal: 16, paddingVertical: 12, borderRadius: radii.sm, alignItems: "center" },
  toastText: { color: "#fff", fontWeight: "600", fontSize: 13, textAlign: "center" },
});
