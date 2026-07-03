import { useEffect, useMemo, useState, useCallback } from "react";
import { View, Text, TextInput, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, Image, Modal, Pressable } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useLocalSearchParams, useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { api } from "@/src/lib/api";
import { colors, fonts, radii, spacing } from "@/src/theme";
import SchedulerModal from "@/src/components/SchedulerModal";
import AccountPicker, { AccountSummary, AccountsMap, SelectedAccounts } from "@/src/components/AccountPicker";

type GenType = "cold-email" | "objection" | "call-script" | "company-intel" | "re-engagement" | "linkedin-post";

const META: Record<GenType, { title: string; subtitle: string; backendType: string; icon: keyof typeof Ionicons.glyphMap; canPostLinkedIn?: boolean }> = {
  "cold-email": { title: "Cold Email", subtitle: "3 variations tailored to your role & industry", backendType: "cold-email", icon: "mail-outline" },
  "objection": { title: "Objection Handler", subtitle: "3 ways to respond to a tough objection", backendType: "objection-response", icon: "shield-checkmark-outline" },
  "call-script": { title: "Call Script", subtitle: "2 openers + 3 discovery questions", backendType: "call-script", icon: "call-outline" },
  "company-intel": { title: "Company Intel", subtitle: "Personalization hooks for your target", backendType: "company-intel", icon: "search-outline" },
  "re-engagement": { title: "Re-Engagement", subtitle: "3 follow-up angles for cold prospects", backendType: "re-engagement", icon: "refresh-outline" },
  "linkedin-post": { title: "Social Post", subtitle: "2 ready-to-post variations", backendType: "linkedin-post", icon: "share-social-outline", canPostLinkedIn: true },
};

export default function GenerateScreen() {
  const { type, historyId } = useLocalSearchParams<{ type: string; historyId?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const t = (type as GenType) || "cold-email";
  const meta = META[t] || META["cold-email"];

  const [form, setForm] = useState<any>({});
  const [output, setOutput] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [posting, setPosting] = useState<string | null>(null);
  const [imageMap, setImageMap] = useState<Record<number, { uri: string; loading?: boolean; error?: string }>>({});
  const [imagePromptMap, setImagePromptMap] = useState<Record<number, string>>({});
  const [topicIdeas, setTopicIdeas] = useState<any[] | null>(null);
  const [topicLoading, setTopicLoading] = useState(false);
  const [activeCompany, setActiveCompany] = useState<{ id: string; name: string; offerings?: string; value_props?: string; industry?: string; target_audience?: string; website?: string; linked_accounts?: Record<string, string> } | null>(null);
  // Scheduler modal state
  const [schedulerIdx, setSchedulerIdx] = useState<number | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [scheduledIdx, setScheduledIdx] = useState<Set<number>>(new Set());
  // Persistence: the id of the current history document. Set after `submit()` succeeds
  // OR when a screen is re-opened from Library via the `historyId` param.
  const [currentHistoryId, setCurrentHistoryId] = useState<string | null>(null);
  // Account-picker state (Option C: hybrid — company drives defaults, user can override).
  const [accountsMap, setAccountsMap] = useState<AccountsMap | null>(null);
  const [selectedAccounts, setSelectedAccounts] = useState<SelectedAccounts>({});
  const [pickerVisible, setPickerVisible] = useState(false);
  // Company switcher: list of user's companies + a bottom-sheet toggle so they can
  // change context inline (Option: right on the generator screen, per user request).
  const [allCompanies, setAllCompanies] = useState<any[]>([]);
  const [companyPickerVisible, setCompanyPickerVisible] = useState(false);
  // Per-variation edit mode: `editedContent[i]` overrides the auto-composed post text
  // when non-null. Used for LinkedIn/Facebook/Instagram posts + copy button.
  const [editedContent, setEditedContent] = useState<Record<number, string>>({});
  const [editingIdx, setEditingIdx] = useState<Set<number>>(new Set());

  const loadActiveCompany = useCallback(async () => {
    try {
      const res = await api.listCompanies();
      setAllCompanies(res.items || []);
      const active = (res.items || []).find((c: any) => c.id === res.active_id);
      setActiveCompany(active || null);
    } catch (e: any) {
      setActiveCompany(null);
    }
  }, []);

  const switchCompany = async (companyId: string) => {
    setCompanyPickerVisible(false);
    try {
      await api.activateCompany(companyId);
      await loadActiveCompany();
      // Re-seed the account picker with the new company's linked accounts
      setSelectedAccounts({});
      setToast("Company switched ✓");
      setTimeout(() => setToast(null), 1500);
    } catch (e: any) {
      setErr(e?.message || "Couldn't switch company");
    }
  };

  useFocusEffect(
    useCallback(() => {
      loadActiveCompany();
    }, [loadActiveCompany])
  );

  useEffect(() => {
    if (historyId) {
      (async () => {
        try {
          // Full detail endpoint returns saved images (base64) + selected_accounts overrides.
          const item = await api.getHistoryItem(historyId as string);
          if (item) {
            setForm(item.input_params || item.input || {});
            setOutput(item.output?.data || item.output);
            setCurrentHistoryId(item.id);
            setSelectedAccounts(item.selected_accounts || {});
            // Rehydrate `imageMap` from saved variant images
            const imgs = item.images || {};
            const nextMap: Record<number, { uri: string }> = {};
            Object.keys(imgs).forEach((k) => {
              const v = imgs[k];
              if (v?.data) {
                nextMap[Number(k)] = { uri: `data:${v.mime || "image/png"};base64,${v.data}` };
              }
            });
            if (Object.keys(nextMap).length) setImageMap(nextMap);
          }
        } catch (e) {
          // swallow — screen still works even if load fails
        }
      })();
    }
  }, [historyId]);

  // Load all available social accounts once so the picker can render quickly.
  useEffect(() => {
    (async () => {
      try {
        const res = await api.socialAllAccounts();
        setAccountsMap(res);
        // If nothing chosen yet, seed from the active company's linked_accounts.
        if (activeCompany?.linked_accounts && !Object.keys(selectedAccounts).length) {
          const linked = activeCompany.linked_accounts;
          const seed: SelectedAccounts = {};
          if (linked.linkedin) seed.linkedin = linked.linkedin;
          if (linked.instagram) seed.instagram = linked.instagram;
          // FB: linked_accounts stores a Composio connection, not a Page id.
          // Auto-pick the first Page returned for that account (best-effort).
          if (res?.facebook_pages?.length) seed.facebook = res.facebook_pages[0].id;
          if (Object.keys(seed).length) setSelectedAccounts(seed);
        }
      } catch (_e) {
        // non-fatal
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCompany?.id]);

  // Persist selected_accounts back to the history doc whenever the user changes them
  // (Option C — the override is remembered next time this history entry is opened).
  useEffect(() => {
    if (!currentHistoryId) return;
    if (!Object.keys(selectedAccounts).length) return;
    // Fire-and-forget; failure isn't user-facing.
    api.patchHistoryItem(currentHistoryId, { selected_accounts: selectedAccounts }).catch(() => {});
  }, [selectedAccounts, currentHistoryId]);

  const suggestTopics = async () => {
    setTopicLoading(true);
    try {
      const res = await api.topicIdeas();
      setTopicIdeas(res.topics || []);
    } catch (e: any) {
      setErr("Couldn't generate topic ideas. Try again.");
    } finally {
      setTopicLoading(false);
    }
  };

  const fields = useMemo(() => fieldsFor(t), [t]);

  const submit = async () => {
    setErr(null);
    setLoading(true);
    setOutput(null);
    // Reset per-generation state — new outputs get a new history entry.
    setImageMap({});
    setCurrentHistoryId(null);
    try {
      const res = await api.generate(meta.backendType, form);
      setOutput(res.output);
      // Capture the fresh history id so subsequent image generations can persist onto it.
      if (res?.id) setCurrentHistoryId(res.id);
    } catch (e: any) {
      setErr(e?.message?.includes("502") ? "AI service is busy. Try again in a moment." : (e?.message || "Something went wrong"));
    } finally {
      setLoading(false);
    }
  };

  const copy = async (text: string) => {
    await Clipboard.setStringAsync(text);
    setToast("Copied");
    setTimeout(() => setToast(null), 1200);
  };

  const postToSocial = async (platform: "linkedin" | "facebook" | "instagram", idx: number, content: string) => {
    const key = `${platform}-${idx}`;
    setPosting(key);
    setErr(null);
    try {
      const image = imageMap[idx];
      const dataUri = image?.uri;
      if (platform === "instagram" && !dataUri) {
        setErr("Instagram needs an image. Tap \"Generate image\" first.");
        return;
      }
      // Parse base64 + mime from data URI; backend will host it publicly for Instagram/Facebook
      let image_b64: string | undefined;
      let image_mime: string | undefined;
      if (dataUri && dataUri.startsWith("data:")) {
        const [head, body] = dataUri.split(",");
        image_b64 = body;
        const m = /data:([^;]+);base64/.exec(head);
        image_mime = m?.[1] || "image/png";
      }
      // Never pass a data: URI as image_url — Instagram needs a real HTTPS URL
      // Include the picker's per-platform account override (Option C hybrid).
      const override = selectedAccounts?.[platform];
      const opts: any = { image_b64, image_mime, history_id: currentHistoryId || undefined };
      if (override) {
        if (platform === "facebook") opts.page_id = override;
        else opts.connection_id = override;
      }
      await api.socialPost(platform, content, opts);
      const withImage = !!image_b64;
      setToast(`Posted to ${platform.charAt(0).toUpperCase() + platform.slice(1)}${withImage ? " with image" : ""} ✓`);
      setTimeout(() => setToast(null), 2000);
    } catch (e: any) {
      const m = e?.message || "";
      if (m.includes("ConnectedAccountNotFound") || m.includes("No connected account")) {
        setErr(`Connect ${platform} in Settings first.`);
      } else {
        setErr(`Couldn't post to ${platform}. ${m.slice(0, 200)}`);
      }
    } finally {
      setPosting(null);
    }
  };

  const generateImage = async (idx: number, hook: string, body: string) => {
    setImageMap((m) => ({ ...m, [idx]: { uri: "", loading: true } }));
    try {
      const customPrompt = imagePromptMap[idx]?.trim();
      const payload: any = customPrompt ? { prompt: customPrompt } : { hook, body };
      // Persist onto the current history doc so the image survives navigation.
      if (currentHistoryId) {
        payload.history_id = currentHistoryId;
        payload.variant_index = idx;
      }
      const res = await api.generatePostImage(payload);
      const uri = `data:${res.mime_type || "image/png"};base64,${res.data}`;
      setImageMap((m) => ({ ...m, [idx]: { uri, loading: false } }));
    } catch (e: any) {
      setImageMap((m) => ({ ...m, [idx]: { uri: "", loading: false, error: "Image generation failed" } }));
    }
  };

  const handleScheduleConfirm = async (idx: number, content: string, isoDatetime: string, platforms: string[]) => {
    setScheduling(true);
    try {
      const img = imageMap[idx];
      let image_b64: string | undefined;
      let image_mime: string | undefined;
      if (img?.uri?.startsWith("data:")) {
        const [head, body] = img.uri.split(",");
        image_b64 = body;
        const mm = /data:([^;]+);base64/.exec(head);
        image_mime = mm?.[1] || "image/png";
      }
      await api.schedulePost({
        content,
        platforms,
        scheduled_for: isoDatetime,
        image_b64,
        image_mime,
        history_id: currentHistoryId || undefined,
        selected_accounts: selectedAccounts,
      });
      setScheduledIdx((s) => new Set(s).add(idx));
      setSchedulerIdx(null);
      const when = new Date(isoDatetime);
      setToast(`✓ Scheduled for ${when.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`);
      setTimeout(() => setToast(null), 3500);
    } catch (e: any) {
      // Throw so modal can display the error
      throw e;
    } finally {
      setScheduling(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <TouchableOpacity testID="generate-back" onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.overline}>Generator</Text>
          <Text style={styles.headerTitle}>{meta.title}</Text>
        </View>
        <View style={styles.headerIcon}>
          <Ionicons name={meta.icon} size={20} color={colors.primary} />
        </View>
      </View>

      <KeyboardAwareScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 100 }]}
        bottomOffset={80}
      >
        <Text style={styles.subtitle}>{meta.subtitle}</Text>

        {/* Active company context banner — tap to switch active company right here on the generator */}
        {activeCompany ? (
          <TouchableOpacity
            testID="active-company-banner"
            style={styles.companyBanner}
            onPress={() => setCompanyPickerVisible(true)}
            onLongPress={() => router.push(`/company/${activeCompany.id}`)}
            activeOpacity={0.85}
          >
            <View style={styles.companyBannerIcon}>
              <Ionicons name="business" size={16} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.companyBannerLabel}>USING CONTEXT FROM</Text>
              <Text style={styles.companyBannerName} numberOfLines={1}>{activeCompany.name}</Text>
              {(() => {
                const missing: string[] = [];
                if (!activeCompany.offerings) missing.push("offerings");
                if (!activeCompany.value_props) missing.push("value props");
                if (!activeCompany.industry) missing.push("industry");
                if (!activeCompany.target_audience) missing.push("audience");
                if (missing.length === 0) {
                  return <Text style={styles.companyBannerMeta}>✓ Full context loaded</Text>;
                }
                return <Text style={styles.companyBannerWarn}>Missing: {missing.join(", ")} · tap to fill</Text>;
              })()}
            </View>
            <Ionicons name="swap-horizontal" size={18} color={colors.textSubtle} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            testID="active-company-empty"
            style={styles.companyBannerEmpty}
            onPress={() => router.push("/(tabs)/settings")}
            activeOpacity={0.85}
          >
            <Ionicons name="warning-outline" size={16} color={colors.error} />
            <Text style={styles.companyBannerEmptyText}>No active company — set one up in Settings for personalized output.</Text>
          </TouchableOpacity>
        )}

        {/* Post-as pill — visible once we have an output to post. Opens the AccountPicker (Option C). */}
        {output && meta.canPostLinkedIn ? (
          <AccountSummary
            selected={selectedAccounts}
            accounts={accountsMap}
            platforms={["linkedin", "facebook", "instagram"]}
            onPress={() => setPickerVisible(true)}
          />
        ) : null}

        {/* Topic suggester (only for Social Post) */}
        {t === "linkedin-post" && (
          <View style={{ marginBottom: spacing.md }}>
            <TouchableOpacity
              testID="suggest-topics-btn"
              style={[styles.imageBtn, { marginTop: 0 }]}
              onPress={suggestTopics}
              disabled={topicLoading}
            >
              {topicLoading ? <ActivityIndicator color={colors.text} /> : <Ionicons name="bulb-outline" size={16} color={colors.text} />}
              <Text style={styles.imageBtnText}>
                {topicLoading ? "Brainstorming topics…" : topicIdeas ? "Suggest different topics" : "Not sure what to post? Suggest topics"}
              </Text>
              <View style={styles.aiPill}><Text style={styles.aiPillText}>AI</Text></View>
            </TouchableOpacity>
            {topicIdeas && topicIdeas.length > 0 && (
              <View style={{ marginTop: 8, gap: 8 }}>
                {topicIdeas.map((t: any, i: number) => (
                  <TouchableOpacity
                    key={i}
                    testID={`topic-idea-${i}`}
                    style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, padding: 12, backgroundColor: "#fff" }}
                    onPress={() => { setForm({ ...form, topic: t.topic }); setTopicIdeas(null); }}
                    activeOpacity={0.7}
                  >
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      {t.tag && <Text style={{ fontSize: 10, color: colors.primary, fontWeight: "800", letterSpacing: 1.2, textTransform: "uppercase" }}>{t.tag}</Text>}
                    </View>
                    <Text style={{ color: colors.text, fontWeight: "700", fontSize: 14, marginBottom: 4 }}>{t.topic}</Text>
                    {t.why && <Text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 17 }}>{t.why}</Text>}
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        )}

        {fields.map((f) => (
          <View key={f.key} style={styles.field}>
            <Text style={styles.label}>{f.label}</Text>
            <TextInput
              testID={`gen-input-${f.key}`}
              style={[styles.input, f.multiline && styles.textarea]}
              value={form[f.key] || ""}
              onChangeText={(v) => setForm({ ...form, [f.key]: v })}
              placeholder={f.placeholder}
              placeholderTextColor={colors.textSubtle}
              multiline={!!f.multiline}
            />
          </View>
        ))}

        {err && <Text testID="gen-error" style={styles.error}>{err}</Text>}

        <TouchableOpacity testID="gen-submit-button" style={styles.primaryBtn} onPress={submit} disabled={loading}>
          {loading ? <ActivityIndicator color="#fff" /> : (
            <>
              <Ionicons name="sparkles" size={16} color="#fff" />
              <Text style={styles.primaryBtnText}>{output ? "Regenerate" : "Generate"}</Text>
            </>
          )}
        </TouchableOpacity>

        {/* Output */}
        {output && (
          <View style={{ marginTop: spacing.lg, gap: 12 }}>
            <Text style={styles.sectionLabel}>Results</Text>
            {renderOutput(
              t,
              output,
              copy,
              meta.canPostLinkedIn ? postToSocial : undefined,
              posting,
              meta.canPostLinkedIn ? generateImage : undefined,
              imageMap,
              imagePromptMap,
              setImagePromptMap,
              scheduledIdx,
              meta.canPostLinkedIn ? (i: number) => setSchedulerIdx(i) : undefined,
              editedContent,
              editingIdx,
              setEditingIdx,
              setEditedContent,
            )}
          </View>
        )}
      </KeyboardAwareScrollView>

      {/* Scheduler modal */}
      {schedulerIdx !== null && (
        <SchedulerModal
          visible={schedulerIdx !== null}
          onClose={() => setSchedulerIdx(null)}
          onConfirm={async (iso, plats) => {
            const variants = output?.variations || [];
            const v = variants[schedulerIdx!];
            const auto = v ? `${v.hook}\n\n${v.body}\n\n${v.hashtags || ""}`.trim() : "";
            // Prefer the user's edited content over the auto-composed version.
            const content = (editedContent && typeof editedContent[schedulerIdx!] === "string")
              ? editedContent[schedulerIdx!]
              : auto;
            await handleScheduleConfirm(schedulerIdx!, content, iso, plats);
          }}
          contentPreview={(() => {
            const v = output?.variations?.[schedulerIdx];
            return v?.hook || "";
          })()}
          defaultPlatforms={(() => {
            const linked = activeCompany?.linked_accounts || {};
            return (["linkedin", "facebook", "instagram"] as const).filter((p) => !!linked[p]) as any;
          })()}
          hasImage={!!imageMap[schedulerIdx]?.uri}
        />
      )}

      {/* Per-post account picker (Option C hybrid). Choice is persisted on the history doc. */}
      <AccountPicker
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        platforms={["linkedin", "facebook", "instagram"]}
        selected={selectedAccounts}
        onChange={setSelectedAccounts}
        title="Choose the account for this post"
      />

      {/* Company switcher — inline bottom sheet so users can change active company
          right on the generator screen (no navigating to Settings). Long-press the
          banner to jump into that company's detail screen. */}
      <Modal
        visible={companyPickerVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setCompanyPickerVisible(false)}
      >
        <Pressable style={pickerStyles.backdrop} onPress={() => setCompanyPickerVisible(false)}>
          <Pressable style={pickerStyles.sheet} onPress={(e) => e.stopPropagation()}>
            <View style={pickerStyles.grabber} />
            <View style={pickerStyles.header}>
              <Text style={pickerStyles.title}>Switch active company</Text>
              <TouchableOpacity onPress={() => setCompanyPickerVisible(false)} hitSlop={12}>
                <Ionicons name="close" size={22} color={colors.textSubtle} />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 420 }}>
              {allCompanies.length === 0 ? (
                <Text style={pickerStyles.emptyText}>
                  You don&apos;t have any companies yet. Add one from Settings → Companies.
                </Text>
              ) : (
                allCompanies.map((c) => {
                  const chosen = activeCompany?.id === c.id;
                  return (
                    <TouchableOpacity
                      key={c.id}
                      testID={`company-switch-${c.id}`}
                      style={[pickerStyles.row, chosen && pickerStyles.rowChosen]}
                      onPress={() => switchCompany(c.id)}
                      activeOpacity={0.75}
                    >
                      <View style={pickerStyles.rowIcon}>
                        <Ionicons name="business" size={16} color={colors.primary} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={pickerStyles.rowName} numberOfLines={1}>{c.name}</Text>
                        {c.industry ? (
                          <Text style={pickerStyles.rowMeta} numberOfLines={1}>{c.industry}</Text>
                        ) : null}
                      </View>
                      {chosen ? (
                        <Ionicons name="checkmark-circle" size={20} color={colors.primary} />
                      ) : (
                        <View style={pickerStyles.radio} />
                      )}
                    </TouchableOpacity>
                  );
                })
              )}
            </ScrollView>
            <TouchableOpacity
              testID="company-picker-manage"
              style={pickerStyles.manageBtn}
              onPress={() => {
                setCompanyPickerVisible(false);
                router.push("/(tabs)/settings" as any);
              }}
            >
              <Ionicons name="settings-outline" size={16} color={colors.primary} />
              <Text style={pickerStyles.manageBtnText}>Manage companies</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {toast && (
        <View testID="gen-toast" style={[styles.toast, { bottom: insets.bottom + 80 }]}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

function fieldsFor(t: GenType) {
  switch (t) {
    case "cold-email":
    case "re-engagement":
      return [
        { key: "contact_name", label: "Contact name", placeholder: "Jane Doe" },
        { key: "contact_title", label: "Contact title", placeholder: "VP of Sales" },
        { key: "company_name", label: "Company name", placeholder: "Acme Inc." },
        { key: "product_pitch", label: "Your pitch", placeholder: "We help teams cut onboarding time by 40%", multiline: true },
        { key: "tone", label: "Tone (optional)", placeholder: "warm and direct" },
        { key: "extra_notes", label: "Extra context (optional)", placeholder: "They use Salesforce", multiline: true },
      ];
    case "objection":
      return [
        { key: "objection", label: "Objection", placeholder: "It's too expensive for us right now.", multiline: true },
        { key: "product_pitch", label: "Your pitch", placeholder: "What you're selling", multiline: true },
      ];
    case "call-script":
      return [
        { key: "contact_name", label: "Contact name", placeholder: "Jane Doe" },
        { key: "company_name", label: "Company name", placeholder: "Acme Inc." },
        { key: "product_pitch", label: "Your pitch", placeholder: "What you're selling", multiline: true },
      ];
    case "company-intel":
      return [
        { key: "company_name", label: "Company name", placeholder: "Acme Inc." },
        { key: "contact_name", label: "Contact (optional)", placeholder: "Jane Doe" },
        { key: "contact_title", label: "Title (optional)", placeholder: "VP of Sales" },
      ];
    case "linkedin-post":
      return [
        { key: "topic", label: "Topic", placeholder: "How I closed my first enterprise deal", multiline: true },
        { key: "tone", label: "Tone (optional)", placeholder: "authentic and confident" },
      ];
    default:
      return [];
  }
}

function renderOutput(
  t: GenType,
  out: any,
  onCopy: (s: string) => void,
  onPost?: (platform: "linkedin" | "facebook" | "instagram", idx: number, content: string) => void,
  postingKey?: string | null,
  onGenerateImage?: (idx: number, hook: string, body: string) => void,
  imageMap?: Record<number, { uri: string; loading?: boolean; error?: string }>,
  imagePromptMap?: Record<number, string>,
  setImagePromptMap?: (fn: any) => void,
  scheduledIdx?: Set<number>,
  onSchedule?: (idx: number) => void,
  editedContent?: Record<number, string>,
  editingIdx?: Set<number>,
  setEditingIdx?: (fn: any) => void,
  setEditedContent?: (fn: any) => void,
) {
  if (t === "cold-email") {
    return (out.variations || []).map((v: any, i: number) => (
      <ResultCard key={i} index={i + 1} tag={v.style} onCopy={() => onCopy(`Subject: ${v.subject}\n\n${v.body}`)}>
        <Text style={styles.subjectLabel}>Subject</Text>
        <Text style={styles.subject}>{v.subject}</Text>
        <Text style={styles.body}>{v.body}</Text>
      </ResultCard>
    ));
  }
  if (t === "re-engagement") {
    return (out.angles || []).map((v: any, i: number) => (
      <ResultCard key={i} index={i + 1} tag={v.angle} onCopy={() => onCopy(`Subject: ${v.subject}\n\n${v.body}`)}>
        <Text style={styles.subjectLabel}>Subject</Text>
        <Text style={styles.subject}>{v.subject}</Text>
        <Text style={styles.body}>{v.body}</Text>
      </ResultCard>
    ));
  }
  if (t === "objection") {
    return (
      <>
        {out.objection && <Text style={styles.objectionRef}>“{out.objection}”</Text>}
        {(out.responses || []).map((r: any, i: number) => (
          <ResultCard key={i} index={i + 1} tag={r.approach} onCopy={() => onCopy(r.script)}>
            <Text style={styles.body}>{r.script}</Text>
          </ResultCard>
        ))}
      </>
    );
  }
  if (t === "call-script") {
    return (
      <>
        <Text style={styles.subSection}>OPENERS</Text>
        {(out.openers || []).map((o: any, i: number) => (
          <ResultCard key={i} index={i + 1} tag={o.label} onCopy={() => onCopy(o.script)}>
            <Text style={styles.body}>{o.script}</Text>
          </ResultCard>
        ))}
        <Text style={styles.subSection}>DISCOVERY QUESTIONS</Text>
        <View style={styles.qaList}>
          {(out.discovery_questions || []).map((q: string, i: number) => (
            <View key={i} style={styles.qaRow}>
              <Text style={styles.qaNum}>{i + 1}</Text>
              <Text style={styles.qaText}>{q}</Text>
            </View>
          ))}
        </View>
      </>
    );
  }
  if (t === "company-intel") {
    return (
      <>
        <Text style={styles.subSection}>{out.company || "PERSONALIZATION HOOKS"}</Text>
        {(out.personalization_hooks || []).map((h: any, i: number) => (
          <ResultCard key={i} index={i + 1} tag={h.use_in} onCopy={() => onCopy(h.hook)}>
            <Text style={styles.body}>{h.hook}</Text>
            {h.why_it_works && <Text style={styles.why}>Why it works: {h.why_it_works}</Text>}
          </ResultCard>
        ))}
        <Text style={styles.subSection}>LIKELY PRIORITIES</Text>
        <View style={styles.qaList}>
          {(out.likely_priorities || []).map((p: string, i: number) => (
            <View key={i} style={styles.qaRow}>
              <Text style={styles.qaNum}>{i + 1}</Text>
              <Text style={styles.qaText}>{p}</Text>
            </View>
          ))}
        </View>
      </>
    );
  }
  if (t === "linkedin-post") {
    return (out.variations || []).map((v: any, i: number) => {
      // Include the hook but avoid duplicating it if the body already starts with it
      const hookText = String(v.hook || "").trim();
      const bodyText = String(v.body || "").trim();
      const normHook = hookText.toLowerCase().replace(/\s+/g, " ");
      const normBody = bodyText.toLowerCase().replace(/\s+/g, " ");
      const bodyStartsWithHook = hookText.length > 0 && (
        normBody.startsWith(normHook) ||
        normBody.startsWith(normHook.replace(/[?!.]+$/, ""))
      );
      const parts: string[] = [];
      if (hookText) parts.push(hookText);
      if (bodyText && !bodyStartsWithHook) parts.push(bodyText);
      else if (bodyText && bodyStartsWithHook) {
        // Body already contains the hook — keep body only, drop the leading hook line
        parts.pop();
        parts.push(bodyText);
      }
      const tagLine = (v.hashtags || []).map((h: string) => (h.startsWith("#") ? h : `#${h}`)).join(" ");
      if (tagLine) parts.push(tagLine);
      const autoFull = parts.join("\n\n");
      // If the user has edited this variation, prefer their text for copy/post/schedule.
      const isEditing = editingIdx?.has(i);
      const full = (editedContent && typeof editedContent[i] === "string") ? editedContent[i] : autoFull;
      const img = imageMap?.[i];
      const renderPlatformBtn = (platform: "linkedin" | "facebook" | "instagram", icon: keyof typeof Ionicons.glyphMap, color: string, label: string) => {
        const key = `${platform}-${i}`;
        const isBusy = postingKey === key;
        const disabledForInsta = platform === "instagram" && !img?.uri;
        return (
          <TouchableOpacity
            key={platform}
            testID={`${platform}-post-${i}`}
            style={[styles.platformBtn, { backgroundColor: color }, disabledForInsta && { opacity: 0.5 }]}
            onPress={() => onPost?.(platform, i, full)}
            disabled={isBusy || disabledForInsta}
          >
            {isBusy ? <ActivityIndicator color="#fff" size="small" /> : (
              <>
                <Ionicons name={icon} size={14} color="#fff" />
                <Text style={styles.platformBtnText}>{label}</Text>
              </>
            )}
          </TouchableOpacity>
        );
      };
      return (
        <ResultCard
          key={i}
          index={i + 1}
          tag={isEditing ? "Editing" : "Post"}
          onCopy={() => onCopy(full)}
        >
          {/* Edit / Done toggle — sits next to the Copy button */}
          <TouchableOpacity
            testID={`edit-toggle-${i}`}
            style={styles.editBtn}
            onPress={() => {
              if (!setEditingIdx || !setEditedContent) return;
              setEditingIdx((prev: Set<number>) => {
                const next = new Set(prev);
                if (next.has(i)) {
                  next.delete(i);
                } else {
                  next.add(i);
                  // Seed the editor with the current composed text if empty.
                  setEditedContent((old: Record<number, string>) => ({ ...old, [i]: (typeof old[i] === "string" ? old[i] : autoFull) }));
                }
                return next;
              });
            }}
            hitSlop={8}
          >
            <Ionicons name={isEditing ? "checkmark" : "create-outline"} size={16} color={colors.primary} />
          </TouchableOpacity>

          {isEditing ? (
            <TextInput
              testID={`edit-input-${i}`}
              multiline
              value={(editedContent && editedContent[i]) ?? autoFull}
              onChangeText={(t) => setEditedContent && setEditedContent((old: Record<number, string>) => ({ ...old, [i]: t }))}
              style={styles.editArea}
              placeholder="Type your post..."
              placeholderTextColor={colors.textSubtle}
              autoFocus
            />
          ) : (
            <>
              <Text style={styles.hook}>{v.hook}</Text>
              <Text style={styles.body}>{v.body}</Text>
              <Text style={styles.tags}>{(v.hashtags || []).map((h: string) => (h.startsWith("#") ? h : `#${h}`)).join(" ")}</Text>
            </>
          )}

          {/* Image area */}
          {img?.uri ? (
            <View style={styles.imageWrap}>
              <Image testID={`post-image-${i}`} source={{ uri: img.uri }} style={styles.postImage} resizeMode="cover" />
              <TouchableOpacity
                testID={`regenerate-image-${i}`}
                style={styles.regenImageBtn}
                onPress={() => onGenerateImage?.(i, v.hook, v.body)}
                disabled={img.loading}
              >
                <Ionicons name="refresh" size={14} color="#fff" />
                <Text style={styles.regenImageText}>Regenerate</Text>
              </TouchableOpacity>
            </View>
          ) : img?.loading ? (
            <View style={[styles.imageWrap, styles.imageLoading]}>
              <ActivityIndicator color={colors.primary} />
              <Text style={styles.imageLoadingText}>Painting your image…</Text>
            </View>
          ) : onGenerateImage ? (
            <TouchableOpacity
              testID={`generate-image-${i}`}
              style={styles.imageBtn}
              onPress={() => onGenerateImage(i, v.hook, v.body)}
            >
              <Ionicons name="image-outline" size={16} color={colors.text} />
              <Text style={styles.imageBtnText}>Generate image</Text>
              <View style={styles.aiPill}><Text style={styles.aiPillText}>AI</Text></View>
            </TouchableOpacity>
          ) : null}

          {img?.error && <Text style={styles.error}>{img.error}</Text>}

          {/* Custom image prompt input (only after first generation) */}
          {onGenerateImage && (
            <View style={{ marginTop: 8 }}>
              <TextInput
                testID={`image-prompt-${i}`}
                style={[styles.input, { fontSize: 13, minHeight: 40, paddingVertical: 8 }]}
                value={imagePromptMap?.[i] || ""}
                onChangeText={(v) => setImagePromptMap?.((m: any) => ({ ...m, [i]: v }))}
                placeholder="Custom image prompt (optional) — overrides auto-prompt"
                placeholderTextColor={colors.textSubtle}
                multiline
              />
            </View>
          )}

          {/* Schedule button — opens slick scheduling modal */}
          {onSchedule && (
            <TouchableOpacity
              testID={`schedule-btn-${i}`}
              style={[styles.scheduleBtn, scheduledIdx?.has(i) && styles.scheduleBtnDone]}
              onPress={() => onSchedule(i)}
              activeOpacity={0.85}
            >
              <Ionicons name={scheduledIdx?.has(i) ? "checkmark-circle" : "calendar-outline"} size={16} color={scheduledIdx?.has(i) ? "#16a34a" : colors.text} />
              <Text style={[styles.scheduleBtnText, scheduledIdx?.has(i) && { color: "#16a34a" }]}>
                {scheduledIdx?.has(i) ? "Scheduled · tap to add another" : "Schedule for later"}
              </Text>
              {!scheduledIdx?.has(i) && <Ionicons name="chevron-forward" size={16} color={colors.textSubtle} />}
            </TouchableOpacity>
          )}

          {/* Platform post buttons */}
          {onPost && (
            <View style={styles.platformRow}>
              {renderPlatformBtn("linkedin", "logo-linkedin", "#0A66C2", "LinkedIn")}
              {renderPlatformBtn("facebook", "logo-facebook", "#1877F2", "Facebook")}
              {renderPlatformBtn("instagram", "logo-instagram", "#E1306C", "Instagram")}
            </View>
          )}
          {onPost && !img?.uri && (
            <Text style={styles.platformHint}>Instagram requires an image — tap &quot;Generate image&quot;.</Text>
          )}
        </ResultCard>
      );
    });
  }
  return null;
}

function ResultCard({ index, tag, children, onCopy, rightAction }: { index: number; tag?: string; children: React.ReactNode; onCopy: () => void; rightAction?: React.ReactNode }) {
  return (
    <View testID={`result-card-${index}`} style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.indexBadge}><Text style={styles.indexBadgeText}>{index}</Text></View>
        {tag ? <Text style={styles.tag}>{tag}</Text> : <View style={{ flex: 1 }} />}
        <View style={{ flex: 1 }} />
        <TouchableOpacity testID={`copy-button-${index}`} onPress={onCopy} style={styles.copyBtn} hitSlop={6}>
          <Ionicons name="copy-outline" size={16} color={colors.text} />
        </TouchableOpacity>
        {rightAction}
      </View>
      <View style={{ marginTop: 10 }}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  headerBar: { flexDirection: "row", alignItems: "center", gap: 10, padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  backBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm },
  headerTitle: { fontSize: 18, fontWeight: "800", color: colors.text, letterSpacing: -0.4, fontFamily: fonts.heading as string },
  headerIcon: { width: 40, height: 40, borderRadius: radii.sm, backgroundColor: "#EEF2FF", alignItems: "center", justifyContent: "center" },
  overline: { color: colors.textSubtle, fontSize: 10, fontWeight: "700", letterSpacing: 2, textTransform: "uppercase" },
  subtitle: { color: colors.textMuted, fontSize: 14, marginTop: 6, marginBottom: spacing.md },
  scroll: { padding: spacing.lg },

  field: { gap: 6, marginBottom: spacing.md },
  label: { fontSize: 12, fontWeight: "700", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 1.4 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: colors.text, backgroundColor: "#fff" },
  textarea: { minHeight: 90, textAlignVertical: "top" },

  primaryBtn: { backgroundColor: colors.primary, paddingVertical: 16, borderRadius: radii.sm, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 4 },
  primaryBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },

  sectionLabel: { color: colors.textSubtle, fontSize: 11, fontWeight: "700", letterSpacing: 2.4, textTransform: "uppercase" },
  subSection: { color: colors.textSubtle, fontSize: 11, fontWeight: "700", letterSpacing: 2, textTransform: "uppercase", marginTop: 8 },

  card: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, backgroundColor: "#fff", padding: spacing.md },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  indexBadge: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.text, alignItems: "center", justifyContent: "center" },
  indexBadgeText: { color: "#fff", fontWeight: "800", fontSize: 11 },
  tag: { color: colors.primary, fontWeight: "700", fontSize: 11, textTransform: "uppercase", letterSpacing: 1.2, maxWidth: 140 },
  copyBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm },

  subjectLabel: { color: colors.textSubtle, fontSize: 10, fontWeight: "700", letterSpacing: 1.8, textTransform: "uppercase" },
  subject: { fontSize: 15, fontWeight: "700", color: colors.text, marginTop: 2 },
  body: { color: colors.text, fontSize: 14, lineHeight: 20, marginTop: 8 },
  why: { color: colors.textMuted, fontSize: 12, marginTop: 6, fontStyle: "italic" },
  hook: { fontSize: 16, fontWeight: "700", color: colors.text, letterSpacing: -0.2 },
  tags: { color: colors.primary, fontSize: 12, marginTop: 8, fontWeight: "600" },
  objectionRef: { color: colors.textMuted, fontSize: 13, fontStyle: "italic", marginBottom: 4 },

  qaList: { gap: 10, marginTop: 4 },
  qaRow: { flexDirection: "row", gap: 10, alignItems: "flex-start", padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, backgroundColor: "#fff" },
  qaNum: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.text, color: "#fff", textAlign: "center", lineHeight: 22, fontSize: 11, fontWeight: "800" },
  qaText: { flex: 1, color: colors.text, lineHeight: 20, fontSize: 14 },

  smallBtn: { backgroundColor: "#0A66C2", paddingHorizontal: 10, paddingVertical: 6, borderRadius: radii.sm, flexDirection: "row", alignItems: "center", gap: 4, marginLeft: 6 },
  smallBtnText: { color: "#fff", fontWeight: "700", fontSize: 12 },

  platformRow: { flexDirection: "row", gap: 6, marginTop: 12 },
  platformBtn: { flex: 1, paddingVertical: 10, borderRadius: radii.sm, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 36 },
  platformBtnText: { color: "#fff", fontWeight: "700", fontSize: 12 },
  platformHint: { color: colors.textSubtle, fontSize: 11, marginTop: 6, textAlign: "center" },

  imageBtn: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12, paddingVertical: 12, paddingHorizontal: 14, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, borderStyle: "dashed", backgroundColor: colors.surface },
  imageBtnText: { color: colors.text, fontWeight: "600", flex: 1 },
  aiPill: { backgroundColor: colors.primary, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  aiPillText: { color: "#fff", fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  imageWrap: { marginTop: 12, borderRadius: radii.sm, overflow: "hidden", borderWidth: 1, borderColor: colors.border, position: "relative" },
  postImage: { width: "100%", aspectRatio: 1, backgroundColor: colors.surfaceAlt },
  imageLoading: { aspectRatio: 1, alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: colors.surface },
  imageLoadingText: { color: colors.textMuted, fontSize: 12 },
  regenImageBtn: { position: "absolute", bottom: 8, right: 8, backgroundColor: "rgba(11,11,15,0.85)", paddingHorizontal: 10, paddingVertical: 6, borderRadius: radii.sm, flexDirection: "row", alignItems: "center", gap: 4 },
  regenImageText: { color: "#fff", fontSize: 11, fontWeight: "700" },

  error: { color: colors.error, fontSize: 13, marginBottom: 8 },
  toast: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  toastText: { backgroundColor: colors.black, color: "#fff", paddingHorizontal: 16, paddingVertical: 10, borderRadius: radii.sm, fontWeight: "600", overflow: "hidden" },

  companyBanner: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, marginBottom: spacing.md, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.primary, backgroundColor: "#EEF2FF" },
  companyBannerIcon: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: "#fff" },
  companyBannerLabel: { color: colors.primary, fontSize: 9, fontWeight: "800", letterSpacing: 1.5 },
  companyBannerName: { color: colors.text, fontWeight: "800", fontSize: 14, marginTop: 1 },
  companyBannerMeta: { color: "#16a34a", fontSize: 11, fontWeight: "600", marginTop: 2 },
  companyBannerWarn: { color: colors.error, fontSize: 11, fontWeight: "600", marginTop: 2 },
  companyBannerEmpty: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12, marginBottom: spacing.md, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.error, borderStyle: "dashed", backgroundColor: "#FEF2F2" },
  companyBannerEmptyText: { color: colors.error, fontSize: 12, fontWeight: "600", flex: 1 },

  scheduleBtn: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10, paddingVertical: 12, paddingHorizontal: 14, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  scheduleBtnDone: { borderColor: "#16a34a", backgroundColor: "#ECFDF5" },
  scheduleBtnText: { color: colors.text, fontWeight: "700", fontSize: 13, flex: 1 },

  // Post-content edit mode
  editBtn: { position: "absolute", top: 12, right: 42, padding: 6, borderRadius: 999, backgroundColor: "#eef2ff" },
  editArea: { marginTop: 4, marginBottom: 8, padding: 12, borderRadius: radii.sm, borderWidth: 1.5, borderColor: colors.primary, backgroundColor: "#fafbff", minHeight: 180, fontSize: 14, lineHeight: 20, color: colors.text, textAlignVertical: "top" },
});

const pickerStyles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  sheet: { backgroundColor: "#fff", borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: spacing.lg, paddingTop: 8, paddingBottom: 20, maxHeight: "82%" },
  grabber: { alignSelf: "center", width: 44, height: 4, borderRadius: 2, backgroundColor: "#dcdcdc", marginBottom: 12 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  title: { fontSize: 18, fontWeight: "800", color: colors.text },
  emptyText: { fontSize: 13, color: colors.textSubtle, textAlign: "center", padding: 24, lineHeight: 20 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, marginBottom: 6, backgroundColor: "#fff" },
  rowChosen: { borderColor: colors.primary, backgroundColor: "#f4f7ff" },
  rowIcon: { width: 32, height: 32, borderRadius: 16, backgroundColor: "#eef2ff", alignItems: "center", justifyContent: "center" },
  rowName: { color: colors.text, fontSize: 14, fontWeight: "700" },
  rowMeta: { color: colors.textSubtle, fontSize: 11, marginTop: 2 },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: colors.border },
  manageBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 10, paddingVertical: 12, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: "#fff" },
  manageBtnText: { color: colors.primary, fontWeight: "700", fontSize: 13 },
});
