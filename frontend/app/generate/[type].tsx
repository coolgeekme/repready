import { useEffect, useMemo, useState } from "react";
import { View, Text, TextInput, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, Image } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { api } from "@/src/lib/api";
import { colors, fonts, radii, spacing } from "@/src/theme";

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
  const [scheduleMap, setScheduleMap] = useState<Record<number, { datetime: string; show: boolean; saving: boolean }>>({});

  useEffect(() => {
    if (historyId) {
      (async () => {
        const list = await api.listHistory();
        const item = (list.items || []).find((i: any) => i.id === historyId);
        if (item) {
          setForm(item.input || {});
          setOutput(item.output?.data);
        }
      })();
    }
  }, [historyId]);

  const fields = useMemo(() => fieldsFor(t), [t]);

  const submit = async () => {
    setErr(null);
    setLoading(true);
    setOutput(null);
    try {
      const res = await api.generate(meta.backendType, form);
      setOutput(res.output);
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
      // Parse base64 + mime from data URI for backend image upload
      let image_b64: string | undefined;
      let image_mime: string | undefined;
      if (dataUri && dataUri.startsWith("data:")) {
        const [head, body] = dataUri.split(",");
        image_b64 = body;
        const m = /data:([^;]+);base64/.exec(head);
        image_mime = m?.[1] || "image/png";
      }
      await api.socialPost(platform, content, { image_url: dataUri, image_b64, image_mime });
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
      const res = await api.generatePostImage(payload);
      const uri = `data:${res.mime_type || "image/png"};base64,${res.data}`;
      setImageMap((m) => ({ ...m, [idx]: { uri, loading: false } }));
    } catch (e: any) {
      setImageMap((m) => ({ ...m, [idx]: { uri: "", loading: false, error: "Image generation failed" } }));
    }
  };

  const schedulePost = async (idx: number, content: string) => {
    const entry = scheduleMap[idx];
    if (!entry?.datetime) {
      setErr("Pick a date and time first");
      return;
    }
    setScheduleMap((m) => ({ ...m, [idx]: { ...entry, saving: true } }));
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
      const sched = new Date(entry.datetime).toISOString();
      await api.schedulePost({ content, platforms: ["linkedin"], scheduled_for: sched, image_b64, image_mime });
      setToast("Scheduled ✓");
      setTimeout(() => setToast(null), 1800);
      setScheduleMap((m) => ({ ...m, [idx]: { datetime: "", show: false, saving: false } }));
    } catch (e: any) {
      setErr(`Schedule failed. ${(e?.message || "").slice(0, 120)}`);
      setScheduleMap((m) => ({ ...m, [idx]: { ...entry, saving: false } }));
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
              scheduleMap,
              setScheduleMap,
              meta.canPostLinkedIn ? schedulePost : undefined,
            )}
          </View>
        )}
      </KeyboardAwareScrollView>

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
      const full = parts.join("\n\n");
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
          tag="Post"
          onCopy={() => onCopy(full)}
        >
          <Text style={styles.hook}>{v.hook}</Text>
          <Text style={styles.body}>{v.body}</Text>
          <Text style={styles.tags}>{(v.hashtags || []).map((h: string) => (h.startsWith("#") ? h : `#${h}`)).join(" ")}</Text>

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

          {/* Schedule row */}
          {onSchedule && (
            <View style={{ marginTop: 10, gap: 8 }}>
              <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                <Ionicons name="time-outline" size={16} color={colors.textMuted} />
                <TextInput
                  testID={`schedule-input-${i}`}
                  style={[styles.input, { flex: 1, fontSize: 13, paddingVertical: 8 }]}
                  value={scheduleMap?.[i]?.datetime || ""}
                  onChangeText={(v) => setScheduleMap?.((m: any) => ({ ...m, [i]: { ...(m[i] || {}), datetime: v, show: true } }))}
                  placeholder="YYYY-MM-DDTHH:mm (e.g., 2026-06-25T15:30)"
                  placeholderTextColor={colors.textSubtle}
                  autoCapitalize="none"
                />
                <TouchableOpacity
                  testID={`schedule-btn-${i}`}
                  style={[styles.platformBtn, { backgroundColor: colors.text, flex: 0, paddingHorizontal: 12 }]}
                  onPress={() => onSchedule(i, full)}
                  disabled={scheduleMap?.[i]?.saving}
                >
                  {scheduleMap?.[i]?.saving ? <ActivityIndicator color="#fff" size="small" /> : (
                    <Text style={styles.platformBtnText}>Schedule</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
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
});
