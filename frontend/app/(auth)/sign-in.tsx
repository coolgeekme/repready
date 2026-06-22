import { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useAuth } from "@/src/contexts/AuthContext";
import { colors, fonts, radii, spacing } from "@/src/theme";

export default function SignIn() {
  const router = useRouter();
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setErr(null);
    setLoading(true);
    try {
      await signIn(email.trim(), password);
    } catch (e: any) {
      setErr(prettifyAuthError(e?.message || String(e)));
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <KeyboardAwareScrollView contentContainerStyle={styles.scroll} bottomOffset={20}>
        <View style={styles.brandRow}>
          <View style={styles.logoBox}><Text style={styles.logoChar}>R</Text></View>
          <Text style={styles.brand}>RepReady</Text>
        </View>

        <Text style={styles.overline}>Sign in</Text>
        <Text style={styles.h1}>Daily prompts for{"\n"}sharper sales reps.</Text>
        <Text style={styles.sub}>Cold emails, objections, call scripts — generated for your role in seconds.</Text>

        <View style={styles.field}>
          <Text style={styles.label}>Email</Text>
          <TextInput
            testID="signin-email-input"
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="you@company.com"
            placeholderTextColor={colors.textSubtle}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Password</Text>
          <TextInput
            testID="signin-password-input"
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor={colors.textSubtle}
            secureTextEntry
            autoComplete="password"
          />
        </View>

        {err && <Text testID="signin-error" style={styles.error}>{err}</Text>}

        <TouchableOpacity testID="signin-submit-button" style={styles.primaryBtn} onPress={submit} disabled={loading}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Sign in</Text>}
          {!loading && <Ionicons name="arrow-forward" size={18} color="#fff" />}
        </TouchableOpacity>

        <TouchableOpacity testID="signin-forgot-link" onPress={() => router.push("/(auth)/forgot-password")}>
          <Text style={styles.link}>Forgot password?</Text>
        </TouchableOpacity>

        <View style={styles.divider} />

        <Text style={styles.muted}>New to RepReady?</Text>
        <TouchableOpacity testID="signin-signup-link" style={styles.secondaryBtn} onPress={() => router.push("/(auth)/sign-up")}>
          <Text style={styles.secondaryBtnText}>Create an account</Text>
        </TouchableOpacity>
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

function prettifyAuthError(msg: string) {
  if (msg.includes("invalid-credential") || msg.includes("wrong-password")) return "Email or password is incorrect.";
  if (msg.includes("user-not-found")) return "No account found for that email.";
  if (msg.includes("too-many-requests")) return "Too many attempts. Try again later.";
  if (msg.includes("network")) return "Network error. Check your connection.";
  return msg.replace("Firebase:", "").trim();
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.lg, paddingTop: spacing.xl, gap: spacing.md, flexGrow: 1 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: spacing.lg },
  logoBox: { width: 32, height: 32, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", borderRadius: radii.sm },
  logoChar: { color: "#fff", fontFamily: fonts.heading as string, fontWeight: "800", fontSize: 18 },
  brand: { fontSize: 18, fontWeight: "700", color: colors.text, fontFamily: fonts.heading as string, letterSpacing: -0.3 },
  overline: { color: colors.textSubtle, fontSize: 11, fontWeight: "700", letterSpacing: 2.4, textTransform: "uppercase", marginTop: spacing.lg },
  h1: { fontSize: 34, lineHeight: 38, fontWeight: "800", color: colors.text, letterSpacing: -1, marginTop: 6, fontFamily: fonts.heading as string },
  sub: { color: colors.textMuted, fontSize: 15, marginTop: 8, marginBottom: spacing.md, lineHeight: 22 },
  field: { gap: 6 },
  label: { fontSize: 12, fontWeight: "700", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 1.4 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, paddingHorizontal: 14, paddingVertical: 14, fontSize: 16, color: colors.text, backgroundColor: "#fff" },
  primaryBtn: { backgroundColor: colors.primary, paddingVertical: 16, borderRadius: radii.sm, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: spacing.sm },
  primaryBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  link: { color: colors.primary, fontWeight: "600", marginTop: 4, alignSelf: "flex-start" },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.lg },
  muted: { color: colors.textMuted, fontSize: 13 },
  secondaryBtn: { borderWidth: 1, borderColor: colors.border, paddingVertical: 14, borderRadius: radii.sm, alignItems: "center" },
  secondaryBtnText: { color: colors.text, fontSize: 15, fontWeight: "600" },
  error: { color: colors.error, fontSize: 13, marginTop: 4 },
});
