# Cap Digital — Tempel Stempel ke PDF

Web app statis (HTML/CSS/JS saja, tanpa backend) untuk menempelkan gambar
stempel (PNG) ke dokumen PDF langsung di browser, lalu mengunduh hasilnya.
Cocok dihosting di **GitHub Pages**. Tidak ada file yang pernah terkirim ke
server mana pun — semua proses (baca PDF, tempel gambar, buat PDF baru)
terjadi di browser pengguna memakai:

- [pdf.js](https://mozilla.github.io/pdf.js/) — merender halaman PDF ke `<canvas>`
- [pdf-lib](https://pdf-lib.js.org/) — menyisipkan gambar PNG ke PDF dan menyimpannya

## Struktur folder

```
pdf-stamp-app/
├── index.html
├── style.css
├── script.js
├── assets/
│   └── stamps/
│       ├── manifest.json      ← daftar stempel yang tampil di panel kiri
│       ├── stempel_disetujui.png
│       ├── stempel_selesai.png
│       ├── stempel_lunas.png
│       ├── stempel_sesuai_asli.png
│       ├── tanda_tangan.png
│       ├── centang.png
│       └── prioritas.png
├── sample/
│   └── contoh-surat.pdf       ← PDF contoh untuk uji coba
└── README.md
```

7 stempel contoh di atas dibuat otomatis hanya sebagai placeholder agar
aplikasi langsung bisa dicoba. Ganti dengan stempel resmi instansi kamu
kapan saja (lihat langkah di bawah).

## Cara deploy ke GitHub Pages

1. Buat repository baru di GitHub, lalu unggah **seluruh isi** folder
   `pdf-stamp-app/` ke root repository tersebut (bukan di dalam subfolder,
   kecuali kamu sesuaikan sendiri).
2. Buka **Settings → Pages** pada repository.
3. Pada **Source**, pilih branch `main` dan folder `/ (root)`, lalu simpan.
4. Tunggu 1–2 menit, situs akan aktif di
   `https://<username-github>.github.io/<nama-repo>/`.

Karena semua path pada `index.html`/`script.js` ditulis relatif
(`assets/stamps/...`, `style.css`, `script.js`), aplikasi tetap berfungsi
baik di root domain maupun di subfolder project seperti di atas — tidak
perlu diedit.

## Menambahkan stempel PNG milik sendiri (permanen)

1. Simpan file PNG (idealnya latar transparan) ke folder `assets/stamps/`.
2. Tambahkan satu baris entri di `assets/stamps/manifest.json`, contoh:
   ```json
   { "file": "stempel_kantor.png", "label": "Stempel Kantor" }
   ```
3. Commit & push. Setelah GitHub Pages selesai build ulang, stempel baru
   otomatis muncul di panel kiri.

Pengguna juga bisa menambahkan gambar PNG sendiri langsung dari tombol
**"+ Tambah gambar sendiri"** di sidebar — tapi ini hanya berlaku untuk
sesi browser saat itu saja (tidak tersimpan permanen di repo).

## Cara pakai

1. Klik **Unggah PDF**, pilih file PDF (atau coba dengan
   `sample/contoh-surat.pdf`).
2. **Ketuk** salah satu stempel di panel untuk menempelkannya otomatis di
   tengah halaman. Atau **tekan-tahan** sebentar lalu **geser** jarinya ke
   posisi yang diinginkan sebelum dilepas — cara ini yang dipakai di iPad
   karena drag-and-drop bawaan browser tidak berjalan di iOS Safari.
3. Ketuk stempel yang sudah ditempel untuk memunculkan kontrolnya: seret
   badan stempel untuk memindah, seret titik ungu di pojok kanan-bawah
   untuk mengubah ukuran, atau ketuk tombol × merah untuk menghapus.
4. Pindah halaman dengan tombol ‹ › di kanan atas bila PDF lebih dari satu
   halaman — stempel yang sudah ditempel di tiap halaman tetap tersimpan.
5. Klik **Unduh PDF** untuk mengunduh dokumen hasil akhir.

Di layar sempit (HP, iPad posisi tegak), panel stempel otomatis jadi rak
yang bisa digeser mendatar di bagian atas, supaya halaman PDF tetap
mendapat ruang selebar mungkin. Di layar lebih lebar (iPad mendatar,
laptop), panel ini kembali jadi kolom di sisi kiri.

## Menjalankan secara lokal (opsional, untuk uji coba sebelum deploy)

Karena aplikasi memuat `manifest.json` lewat `fetch()`, membuka
`index.html` langsung dari file explorer (`file://...`) tidak akan
memuat daftar stempel. Jalankan server lokal sederhana dari dalam folder
ini, misalnya:

```
python3 -m http.server 8000
```

lalu buka `http://localhost:8000` di browser.

## Keterbatasan yang perlu diketahui

- Perlu koneksi internet saat dipakai, karena pdf.js dan pdf-lib dimuat
  dari CDN (cdnjs). Kalau ingin sepenuhnya offline, unduh kedua library
  itu dan ubah tag `<script>`/`import` di `index.html` & `script.js` agar
  menunjuk ke file lokal.
- Halaman PDF yang memiliki rotasi bawaan (jarang terjadi pada dokumen
  perkantoran biasa) bisa membuat posisi stempel pada hasil unduhan
  sedikit meleset — aplikasi akan menampilkan peringatan singkat bila ini
  terdeteksi.
- Ukuran file PNG stempel sebaiknya tidak terlalu besar (idealnya di
  bawah 300–400 KB) agar proses render di sidebar dan penyisipan ke PDF
  tetap ringan.
