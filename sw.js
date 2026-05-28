// 왓츠디너 Service Worker v1.5
// 2단계 알림: 7시(급식분석) + 9시(쿠팡주문 마감 알림)
const CACHE_NAME = 'whatsdinner-v1';

self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(clients.claim()); });

// ── 푸시 알림 수신 ──
self.addEventListener('push', e => {
  const data = e.data?.json() || {};
  e.waitUntil(self.registration.showNotification(data.title || '왓츠디너', {
    body: data.body || '오늘 급식을 확인해보세요',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    tag: 'whatsdinner-daily',
    data: { url: '/' },
  }));
});

// ── 알림 클릭 ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      if (list.length > 0) return list[0].focus();
      return clients.openWindow('/');
    })
  );
});

// ── 로컬 알람 메시지 수신 ──
self.addEventListener('message', e => {
  if (e.data?.type === 'CANCEL_ALARM') {
    clearTimeout(self._alarm7Timer);
    clearTimeout(self._alarm9Timer);
    console.log('왓츠디너 알람 전체 취소됨');
    return;
  }
  if (e.data?.type !== 'SCHEDULE_ALARM') return;

  const { members } = e.data;
  self._alarmMembers = members;

  scheduleAlarms(members);
});

// ── 알람 스케줄링 ──
function scheduleAlarms(members) {
  const now  = new Date();

  // ① 7시 알람 (급식 분석 + 저녁 추천)
  const next7 = new Date();
  next7.setHours(7, 0, 0, 0);
  if (next7 <= now) next7.setDate(next7.getDate() + 1);

  // ② 9시 알람 (쿠팡 주문 마감 알림)
  const next9 = new Date();
  next9.setHours(9, 0, 0, 0);
  if (next9 <= now) next9.setDate(next9.getDate() + 1);

  clearTimeout(self._alarm7Timer);
  clearTimeout(self._alarm9Timer);

  self._alarm7Timer = setTimeout(() => fireAlarm7(members), next7 - now);
  self._alarm9Timer = setTimeout(() => fireAlarm9(members), next9 - now);

  const m7 = Math.round((next7 - now) / 1000 / 60);
  const m9 = Math.round((next9 - now) / 1000 / 60);
  console.log(`왓츠디너 7시 알람: ${m7}분 후 / 9시 알람: ${m9}분 후`);

  // 설정 완료 확인 알림
  self.registration.showNotification('✅ 왓츠디너 알림 설정 완료', {
    body: '매일 ⏰ 7시 급식알림 + 🛒 9시 쿠팡주문 알림을 보내드려요!',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    tag: 'whatsdinner-setup',
  });
}

// ── 7시 알람: 급식 분석 알림 ──
async function fireAlarm7(members) {
  if (!members?.length) return;

  const NEIS_KEY = 'c73b1f34c0444aa9b32fae1dd50c4f28';
  const today    = new Date();
  const dateStr  = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;

  const allergyMap = {
    '1':'난류','2':'우유','3':'메밀','4':'땅콩','5':'대두','6':'밀',
    '7':'고등어','8':'게','9':'새우','10':'돼지고기','11':'복숭아',
    '12':'토마토','13':'아황산류','14':'호두','15':'소고기',
    '16':'닭고기','17':'오징어','18':'조개류'
  };

  let notifications = [];

  for (const member of members) {
    if (!member.school) continue;
    try {
      const res  = await fetch(
        `https://open.neis.go.kr/hub/mealServiceDietInfo?KEY=${NEIS_KEY}&Type=json&pIndex=1&pSize=5` +
        `&ATPT_OFCDC_SC_CODE=${member.school.sido}&SD_SCHUL_CODE=${member.school.code}&MLSV_YMD=${dateStr}`
      );
      const data = await res.json();
      const row  = data?.mealServiceDietInfo?.[1]?.row?.[0];
      if (!row) continue;

      const rawDdish = row.DDISH_NM || '';
      const ntrInfo  = row.NTR_INFO  || '';
      const menuNames = rawDdish.replace(/<br\/>/g, ',').split(',')
        .map(d => d.replace(/\([^)]*\)/g, '').trim()).filter(Boolean);

      // 알레르기 감지
      const foundNos = [...new Set(
        [...rawDdish.matchAll(/\(([^)]+)\)/g)]
          .flatMap(m => m[1].split('.').map(s => s.trim()))
          .filter(s => /^\d+$/.test(s))
      )];
      const allergyHits = (member.allergyNos || [])
        .filter(no => foundNos.includes(no))
        .map(no => allergyMap[no]);

      if (allergyHits.length > 0) {
        notifications.push({
          title: `🚨 ${member.name} 알레르기 주의!`,
          body:  `오늘 급식에 ${allergyHits.join(', ')} 포함\n학교에 미리 알려주세요`,
          priority: 1, tag: 'allergy',
        });
      }

      // 당류 → 간식 주의보
      const sugarMatch = ntrInfo.match(/당류\(g\)\s*:\s*([\d.]+)/);
      const sugarVal   = sugarMatch ? parseFloat(sugarMatch[1]) : 0;
      if (sugarVal > 15) {
        notifications.push({
          title: `🍬 ${member.name} 간식 주의보`,
          body:  `오늘 급식 당류 ${sugarVal}g · 오후 간식은 단 것 피해주세요`,
          priority: 2, tag: 'sugar',
        });
      }

      // 나트륨 주의보
      if ((member.healthFlags || []).includes('sodium')) {
        const sodiumMatch = ntrInfo.match(/나트륨\(㎎\)\s*:\s*([\d.]+)/);
        const sodiumVal   = sodiumMatch ? parseFloat(sodiumMatch[1]) : 0;
        if (sodiumVal > 800) {
          notifications.push({
            title: `🧂 ${member.name} 영양 주의보`,
            body:  `오늘 급식 나트륨 ${sodiumVal}mg · 저녁은 싱겁게 드세요`,
            priority: 3, tag: 'sodium',
          });
        }
      }

      // 기본 급식 알림
      if (notifications.length === 0) {
        notifications.push({
          title: `🍽️ ${member.name} 오늘 급식`,
          body:  menuNames.slice(0, 3).join(' · '),
          priority: 9, tag: 'meal',
        });
      }

    } catch(err) { console.log('7시 알람 오류:', err); }
  }

  // 발송
  notifications.sort((a, b) => a.priority - b.priority);
  for (let i = 0; i < Math.min(notifications.length, 2); i++) {
    await new Promise(r => setTimeout(r, i * 1200));
    await self.registration.showNotification(notifications[i].title, {
      body:             notifications[i].body,
      icon:             '/icon-192.png',
      badge:            '/icon-192.png',
      vibrate:          i === 0 ? [300, 100, 300] : [200],
      tag:              `whatsdinner-7-${notifications[i].tag}`,
      requireInteraction: i === 0,
      data:             { url: '/' },
    });
  }

  // 내일 7시 재설정
  const tomorrow7 = new Date();
  tomorrow7.setDate(tomorrow7.getDate() + 1);
  tomorrow7.setHours(7, 0, 0, 0);
  self._alarm7Timer = setTimeout(() => fireAlarm7(self._alarmMembers), tomorrow7 - new Date());
}

// ── 9시 알람: 쿠팡 주문 마감 알림 ──
async function fireAlarm9(members) {
  if (!members?.length) return;

  const names = members.map(m => m.name).join(', ');

  await self.registration.showNotification('🛒 쿠팡 주문 마감 1시간 전!', {
    body: `${names}의 저녁 재료, 10시 전에 주문하면 오늘 저녁 도착!\n왓츠디너에서 추천 받은 메뉴 장보기 👇`,
    icon:             '/icon-192.png',
    badge:            '/icon-192.png',
    vibrate:          [200, 100, 200, 100, 200],
    tag:              'whatsdinner-9-order',
    requireInteraction: true,
    data:             { url: '/' },
    actions: [
      { action: 'open', title: '지금 장보기 🛒' },
      { action: 'close', title: '나중에' },
    ],
  });

  // 내일 9시 재설정
  const tomorrow9 = new Date();
  tomorrow9.setDate(tomorrow9.getDate() + 1);
  tomorrow9.setHours(9, 0, 0, 0);
  self._alarm9Timer = setTimeout(() => fireAlarm9(self._alarmMembers), tomorrow9 - new Date());
}
