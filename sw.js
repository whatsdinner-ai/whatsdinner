// 왓츠디너 Service Worker v1.3 (테스트: 10분마다)
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
    clearTimeout(self._alarmTimer);
    console.log('왓츠디너 알람 취소됨');
    return;
  }
  if (e.data?.type !== 'SCHEDULE_ALARM') return;
  const { members } = e.data;
  self._alarmMembers = members;

  // 테스트: 10분 후 첫 발송
  const INTERVAL = 10 * 60 * 1000; // 10분
  clearTimeout(self._alarmTimer);
  self._alarmTimer = setTimeout(() => fireAlarm(members, INTERVAL), INTERVAL);
  console.log(`왓츠디너 테스트 알람: 10분 후 발송`);

  // 즉시 테스트 알림 (등록 확인용)
  self.registration.showNotification('✅ 왓츠디너 알림 설정 완료', {
    body: '30분 후 첫 급식 알림이 발송돼요!\n아침 7시 알림도 자동 설정됐어요 🍽️',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    tag: 'whatsdinner-setup',
  });
});

// ── 알람 실행 ──
async function fireAlarm(members, interval) {
  if (!members?.length) return;

  const NEIS_KEY = 'c73b1f34c0444aa9b32fae1dd50c4f28';
  const today = new Date();
  const dateStr = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;

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
      const res = await fetch(
        `https://open.neis.go.kr/hub/mealServiceDietInfo?KEY=${NEIS_KEY}&Type=json&pIndex=1&pSize=5&ATPT_OFCDC_SC_CODE=${member.school.sido}&SD_SCHUL_CODE=${member.school.code}&MLSV_YMD=${dateStr}`
      );
      const data = await res.json();
      const row = data?.mealServiceDietInfo?.[1]?.row?.[0];
      if (!row) continue;

      const rawDdish = row.DDISH_NM || '';
      const ntrInfo = row.NTR_INFO || '';
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
          body: `오늘 급식에 ${allergyHits.join(', ')} 포함\n학교에 미리 알려주세요`,
          priority: 1,
        });
      }

      // 당류 → 간식 주의보
      const sugarMatch = ntrInfo.match(/당류\(g\)\s*:\s*([\d.]+)/);
      const sugarVal = sugarMatch ? parseFloat(sugarMatch[1]) : 0;
      if (sugarVal > 15) {
        notifications.push({
          title: `🍬 ${member.name} 간식 주의보`,
          body: `오늘 급식 당류 ${sugarVal}g · 오후 간식은 단 것 피해주세요`,
          priority: 2,
        });
      }

      // 나트륨 → 영양 주의보
      if ((member.healthFlags || []).includes('sodium')) {
        const sodiumMatch = ntrInfo.match(/나트륨\(㎎\)\s*:\s*([\d.]+)/);
        const sodiumVal = sodiumMatch ? parseFloat(sodiumMatch[1]) : 0;
        if (sodiumVal > 800) {
          notifications.push({
            title: `🧂 ${member.name} 영양 주의보`,
            body: `오늘 급식 나트륨 ${sodiumVal}mg · 저녁은 싱겁게 드세요`,
            priority: 3,
          });
        }
      }

    } catch(err) { console.log('알람 오류:', err); }
  }

  // 알림 없으면 기본 메뉴 알림
  if (notifications.length === 0) {
    const menuRes = await fetchTodayMenuNames(members[0], dateStr, NEIS_KEY);
    notifications.push({
      title: '🍽️ 왓츠디너 · 오늘 급식',
      body: menuRes || `${members.map(m => m.name).join(', ')}의 급식을 확인해보세요!`,
      priority: 9,
    });
  }

  // 발송
  notifications.sort((a, b) => a.priority - b.priority);
  for (let i = 0; i < Math.min(notifications.length, 2); i++) {
    await new Promise(r => setTimeout(r, i * 1200));
    await self.registration.showNotification(notifications[i].title, {
      body: notifications[i].body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      vibrate: i === 0 ? [300, 100, 300] : [200],
      tag: `whatsdinner-${i}`,
      requireInteraction: i === 0,
      data: { url: '/' },
    });
  }

  // 다음 알람 재설정 (30분 반복)
  self._alarmTimer = setTimeout(() => fireAlarm(self._alarmMembers, interval), interval);
}

async function fetchTodayMenuNames(member, dateStr, key) {
  try {
    const res = await fetch(
      `https://open.neis.go.kr/hub/mealServiceDietInfo?KEY=${key}&Type=json&pIndex=1&pSize=5&ATPT_OFCDC_SC_CODE=${member.school.sido}&SD_SCHUL_CODE=${member.school.code}&MLSV_YMD=${dateStr}`
    );
    const data = await res.json();
    const row = data?.mealServiceDietInfo?.[1]?.row?.[0];
    if (!row) return null;
    const menus = row.DDISH_NM.replace(/<br\/>/g, ',').split(',')
      .map(d => d.replace(/\([^)]*\)/g, '').trim()).filter(Boolean);
    return menus.slice(0, 3).join(' · ');
  } catch { return null; }
}
