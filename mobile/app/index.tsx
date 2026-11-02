import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function Home() {
  return <SafeAreaView style={s.safe}><ScrollView contentContainerStyle={s.body}>
    <Text style={s.title}>EuroFlow</Text><Text style={s.label}>Product preview — no real money</Text>
    <Text style={s.text}>This prototype is not a bank or a live payment service. It cannot hold, deposit, transfer, or withdraw money.</Text>
    <View style={s.card}><Text style={s.label}>Payments are unavailable</Text><Text style={s.text}>A regulated payment provider, real settlement and reconciliation, fraud controls, and operational approval are required before transactions can be enabled.</Text></View>
    <View style={s.card}><Text style={s.label}>Identity verification is unavailable</Text><Text style={s.text}>Do not enter bank details, card numbers, identity documents, or personal financial information. No KYC provider is connected.</Text></View>
    <View style={s.card}><Text style={s.label}>Privacy in this preview</Text><Text style={s.text}>This screen works offline. It has no account creation, analytics, network requests, or financial data collection.</Text></View>
  </ScrollView></SafeAreaView>;
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0b1625' },
  body: { padding: 24, gap: 16 },
  title: { color: '#fff', fontSize: 30, fontWeight: '700' },
  text: { color: '#dce6f0', fontSize: 16, lineHeight: 24 },
  label: { color: '#f4ca83', fontSize: 16, fontWeight: '600' },
  card: { padding: 18, gap: 10, backgroundColor: '#172b40', borderRadius: 12 },
  input: { color: '#fff', borderColor: '#a5bbce', borderWidth: 1, borderRadius: 8, padding: 12, fontSize: 16 },
});
