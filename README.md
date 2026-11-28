# RadioLink Universal Relay + Neon PostgreSQL

এই ব্যাকএন্ড প্যাকেজটি কোনো কোড পরিবর্তন ছাড়াই **Render**, **Railway**, **Koyeb**, এবং **Oracle Cloud Always Free VPS** সহ যেকোনো সেলফ-হোস্টেড সার্ভারে চলবে এবং সব ইউজার, আমেরিকান কলসাইন, সার্ভার লিস্ট, রিপোর্ট, ব্যান এবং Admin/Moderator রোল **Neon PostgreSQL**-এ সংরক্ষণ করবে।

---

## ১. GitHub ছাড়া Neon ডাটাবেস সংযোগ
1. [neon.tech](https://neon.tech)-এ প্রজেক্ট থেকে `DATABASE_URL` (`postgresql://...`) কপি করুন।
2. আপনার হোস্টিং প্ল্যাটফর্মে নিচের ২টি Environment Variable সেট করুন:
   - `DATABASE_URL` = Neon থেকে কপি করা `postgresql://...` লিংক
   - `ADMIN_PIN` = আপনার Master Admin পিন (ডিফল্ট `7788`)
3. সার্ভার চালু হওয়া মাত্রই `radiolink_users`, `radiolink_reports`, `radiolink_servers`, `radiolink_roles`, এবং `radiolink_config` টেবিল স্বয়ংক্রিয়ভাবে তৈরি হবে।

---

## ২. ক্লাউড প্ল্যাটফর্ম ডিপ্লয় (Render / Railway / Koyeb)
- **Render**: এই ফোল্ডারের ফাইলগুলো আপলোড করুন অথবা `render.yaml` ব্যবহার করুন (`npm install` + `node server.js`)।
- **Railway**: প্রজেক্টে `railway.toml` ও `Dockerfile` অটো-ডিটেক্ট হয়ে ডিপ্লয় হবে।
- **Koyeb**: `Dockerfile` বা Node buildpack দিয়ে ডিপ্লয় করুন এবং Port `10000` (অথবা `$PORT`) ও `DATABASE_URL` দিন।

---

## ৩. Oracle Cloud Always Free Tier VPS সেটআপ (২৪/৭ আনলিমিটেড ফ্রি)
1. **VM তৈরি**: Oracle Cloud Console -> Compute -> Instances -> **Create Instance**। Image হিসেবে **Ubuntu 22.04/24.04** এবং Shape হিসেবে **VM.Standard.A1.Flex** (Always Free ARM) অথবা **VM.Standard.E2.1.Micro** সিলেক্ট করুন।
2. **ফায়ারওয়াল খোলা**:
   - Oracle Console -> Networking -> VCN -> Subnet -> Security List -> **Ingress Rules**-এ `0.0.0.0/0` থেকে TCP Port `80` এবং `443` এলাউ করুন।
   - VM-এ SSH করে ঢুকে চালাুন:
     ```bash
     sudo apt update && sudo apt install -y docker.io docker-compose-v2
     sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
     ```
3. **ডোমেইন ও SSL (WSS)**:
   - [duckdns.org](https://www.duckdns.org) থেকে ফ্রি সাবডোমেইন নিয়ে আপনার Oracle VPS-এর Public IP বসান।
4. **সার্ভার চালু করুন**:
   ```bash
   export DATABASE_URL="postgresql://..."
   export ADMIN_PIN="7788"
   export RELAY_DOMAIN="yourname.duckdns.org"
   sudo -E docker compose up -d --build
   ```
5. আপনার রিলে URL তৈরি: `https://yourname.duckdns.org/` — এটি অ্যাডমিন অ্যাপের **সার্ভার** ট্যাবে বসিয়ে **"Test & Health"** চাপুন!
