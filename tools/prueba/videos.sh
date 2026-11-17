#!/bin/sh
# Vídeos de prueba hechos aquí mismo (nada con derechos): MP4, WebM, MKV con .srt y AVI
set -e
D="${1:-videos}"
mkdir -p "$D/Viajes"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc2=size=640x360:rate=30 -f lavfi -i sine=frequency=440 -t 25 -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart "$D/Prueba uno.mp4"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc=size=640x360:rate=25 -f lavfi -i sine=frequency=660 -t 15 -c:v libvpx-vp9 -b:v 300k -c:a libopus "$D/Viajes/Playa.webm"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i smptebars=size=640x360:rate=25 -f lavfi -i sine=frequency=330 -t 12 -c:v libx264 -pix_fmt yuv420p -c:a aac "$D/Concierto_en_directo.mkv"
printf '1\n00:00:01,000 --> 00:00:04,000\nHola, esto es un subtítulo\n' > "$D/Concierto_en_directo.es.srt"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i mandelbrot=size=320x240:rate=25 -f lavfi -i sine=frequency=550 -t 10 -c:v mpeg4 -c:a libmp3lame "$D/Viejo.avi"
ls -la "$D"
