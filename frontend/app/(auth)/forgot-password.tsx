import { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/src/contexts/AuthContext";
import { colors, fonts, radii, spacing } from "@/src/theme";

export default function ForgotPassword() {
  const router = useRouter();
  const { resetPassword } = useAuth();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sent" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setLoading(true);
    setMsg(null);
    try {
      await resetPassword(email.trim());
      setStatus("sent");
    } catch (e: any) {
      setStatus("error");
      setMsg((e?.message || String(e)).replace("Firebase:", "").trim());
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <KeyboardAwareScrollView contentContainerStyle={styles.scroll} bottomOffset={20}>
        <TouchableOpacity testID="forgot-back-button" onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>

        <Text style={styles.overline}>Password reset</Text>
        <Text style={styles.h1}>Get back to{"\n"}closing deals.</Text>
        <Text style={styles.sub}>We&apos;ll email you a reset link.</Text>

        <View style={styles.field}>
          <Text style={styles.label}>Email</Text>
          <TextInput
            testID="forgot-email-input"
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="you@company.com"
            placeholderTextColor={colors.textSubtle}
            keyboardType="email-address"
            autoCapitalize="none"
          />
        </View>

        {status === "sent" && <Text testID="forgot-success" style={styles.success}>Check your inbox for a reset link.</Text>}
        {status === "error" && msg && <Text testID="forgot-error" style={styles.error}>{msg}</Text>}

        <TouchableOpacity testID="forgot-submit-button" style={styles.primaryBtn} onPress={submit} disabled={loading}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Send reset link</Text>}
        </TouchableOpacity>
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.lg, gap: spacing.md, flexGrow: 1 },
  backBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, marginBottom: spacing.sm },
  overline: { color: colors.textSubtle, fontSize: 11, fontWeight: "700", letterSpacing: 2.4, textTransform: "uppercase" },
  h1: { fontSize: 32, lineHeight: 36, fontWeight: "800", color: colors.text, letterSpacing: -1, marginTop: 4, fontFamily: fonts.heading as string },
  sub: { color: colors.textMuted, fontSize: 15, marginBottom: spacing.md, marginTop: 4 },
  field: { gap: 6 },
  label: { fontSize: 12, fontWeight: "700", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 1.4 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, paddingHorizontal: 14, paddingVertical: 14, fontSize: 16, color: colors.text, backgroundColor: "#fff" },
  primaryBtn: { backgroundColor: colors.primary, paddingVertical: 16, borderRadius: radii.sm, alignItems: "center", marginTop: spacing.sm },
  primaryBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  success: { color: colors.success, fontWeight: "600" },
  error: { color: colors.error, fontSize: 13 },
});
