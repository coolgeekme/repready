import { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/src/contexts/AuthContext";
import { colors, fonts, radii, spacing } from "@/src/theme";

export default function SignUp() {
  const router = useRouter();
  const { signUp } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setErr(null);
    if (password.length < 6) {
      setErr("Password must be at least 6 characters.");
      return;
    }
    setLoading(true);
    try {
      await signUp(email.trim(), password, name.trim());
    } catch (e: any) {
      setErr((e?.message || String(e)).replace("Firebase:", "").trim());
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <KeyboardAwareScrollView contentContainerStyle={styles.scroll} bottomOffset={20}>
        <TouchableOpacity testID="signup-back-button" onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>

        <Text style={styles.overline}>Create account</Text>
        <Text style={styles.h1}>Start your daily{"\n"}sales edge.</Text>

        <View style={styles.field}>
          <Text style={styles.label}>Name</Text>
          <TextInput
            testID="signup-name-input"
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Alex Rep"
            placeholderTextColor={colors.textSubtle}
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Email</Text>
          <TextInput
            testID="signup-email-input"
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="you@company.com"
            placeholderTextColor={colors.textSubtle}
            keyboardType="email-address"
            autoCapitalize="none"
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Password</Text>
          <TextInput
            testID="signup-password-input"
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="At least 6 characters"
            placeholderTextColor={colors.textSubtle}
            secureTextEntry
          />
        </View>

        {err && <Text testID="signup-error" style={styles.error}>{err}</Text>}

        <TouchableOpacity testID="signup-submit-button" style={styles.primaryBtn} onPress={submit} disabled={loading}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Create account</Text>}
        </TouchableOpacity>

        <TouchableOpacity testID="signup-signin-link" onPress={() => router.replace("/(auth)/sign-in")}>
          <Text style={styles.muted}>Already have an account? <Text style={styles.link}>Sign in</Text></Text>
        </TouchableOpacity>
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.lg, paddingTop: spacing.md, gap: spacing.md, flexGrow: 1 },
  backBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, marginBottom: spacing.sm },
  overline: { color: colors.textSubtle, fontSize: 11, fontWeight: "700", letterSpacing: 2.4, textTransform: "uppercase" },
  h1: { fontSize: 32, lineHeight: 36, fontWeight: "800", color: colors.text, letterSpacing: -1, marginTop: 4, marginBottom: spacing.md, fontFamily: fonts.heading as string },
  field: { gap: 6 },
  label: { fontSize: 12, fontWeight: "700", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 1.4 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, paddingHorizontal: 14, paddingVertical: 14, fontSize: 16, color: colors.text, backgroundColor: "#fff" },
  primaryBtn: { backgroundColor: colors.primary, paddingVertical: 16, borderRadius: radii.sm, alignItems: "center", marginTop: spacing.sm },
  primaryBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  muted: { color: colors.textMuted, fontSize: 14, marginTop: 12, textAlign: "center" },
  link: { color: colors.primary, fontWeight: "700" },
  error: { color: colors.error, fontSize: 13 },
});
