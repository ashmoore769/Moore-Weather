/* Free model forecasts, deliberately kept separate from station observations. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const tz = 'Australia/Brisbane';
  const localDate = timestamp => new Intl.DateTimeFormat('en-CA', { timeZone:tz, year:'numeric',month:'2-digit',day:'2-digit' }).format(timestamp);
  const time = timestamp => new Intl.DateTimeFormat('en-AU', { timeZone:tz, hour:'numeric',minute:'2-digit' }).format(timestamp);
  const date = timestamp => new Intl.DateTimeFormat('en-AU', { timeZone:tz, weekday:'long',day:'numeric',month:'long' }).format(timestamp);
  const number = (value, digits = 0) => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
  const amount = value => typeof value === 'number' && Number.isFinite(value) ? (value === 0 ? '0' : value < .1 ? '<0.1' : value.toFixed(1)) : '—';
  const paths = {
    sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/>',
    cloud:'<path d="M6 18a4 4 0 0 1-.2-8A6 6 0 0 1 17 8a5 5 0 1 1 1 10H6Z"/>',
    partly:'<path d="M9 3v2M2 10h2M4 5l2 2M14 5l-1 1"/><path d="M6 12a4 4 0 1 1 7-4M7 20a4 4 0 0 1 0-8 5 5 0 0 1 9-2 5 5 0 1 1 2 10H7Z"/>',
    rain:'<path d="M6 14a4 4 0 0 1 0-8 5 5 0 0 1 9-1 5 5 0 1 1 3 9H6ZM8 17l-1 3M13 17l-1 3M18 17l-1 3"/>',
    storm:'<path d="M5 14a4 4 0 0 1 1-8 5 5 0 0 1 9-1 5 5 0 1 1 3 9M13 12l-4 6h4l-2 5 6-8h-4l2-3"/>',
    fog:'<path d="M6 12a4 4 0 0 1 0-8 5 5 0 0 1 9 1 4 4 0 1 1 2 7H6ZM3 16h18M5 20h14"/>',
    snow:'<path d="M6 12a4 4 0 0 1 0-8 5 5 0 0 1 9 1 4 4 0 1 1 2 7H6ZM7 16v6M4.5 17.5l5 3M4.5 20.5l5-3M17 16v6M14.5 17.5l5 3M14.5 20.5l5-3"/>'
  };
  function weather(code) {
    if (code === 0) return ['Clear skies','sun'];
    if (code === 1) return ['Mostly clear','partly'];
    if (code === 2) return ['Partly cloudy','partly'];
    if (code === 3) return ['Overcast','cloud'];
    if ([45,48].includes(code)) return ['Fog','fog'];
    if ([51,53,55].includes(code)) return ['Drizzle','rain'];
    if ([56,57,66,67].includes(code)) return ['Freezing rain','rain'];
    if ([61,63,65].includes(code)) return [code===65?'Heavy rain':'Rain','rain'];
    if ([80,81,82].includes(code)) return [code===82?'Heavy showers':'Showers','rain'];
    if ([71,73,75,77,85,86].includes(code)) return ['Snow','snow'];
    if ([95,96,99].includes(code)) return ['Thunderstorms','storm'];
    return ['Conditions unavailable','cloud'];
  }
  const icon = code => `<svg class="weather-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[weather(code)[1]]}</svg>`;
  function dayName(seconds) {
    const key = localDate(seconds * 1000), today = localDate(Date.now());
    if (key === today) return 'Today';
    if (key === localDate(Date.now() + 86400000)) return 'Tomorrow';
    return new Intl.DateTimeFormat('en-AU',{timeZone:tz,weekday:'short'}).format(seconds*1000);
  }
  function direction(degrees) { return Number.isFinite(degrees) ? ['N','NE','E','SE','S','SW','W','NW'][Math.round(degrees / 45) % 8] : ''; }
  function sunTime(seconds) { return Number.isFinite(seconds) ? time(seconds * 1000) : '—'; }
  let data, selected, busy = false, lastAttempt = 0;
  function status(message, kind = '') { $('forecastStatus').textContent = message; $('forecastStatus').dataset.kind = kind; }
  function renderDay(day) {
    selected = day.time;
    document.querySelectorAll('.forecast-day').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.time) === selected)));
    $('selectedDate').textContent = dayName(day.time) + ' · ' + date(day.time * 1000);
    $('selectedCondition').textContent = weather(day.weather_code)[0];
    $('selectedDescription').textContent = 'Forecast for the Warwick area';
    $('selectedIcon').innerHTML = icon(day.weather_code);
    $('selectedHigh').textContent = number(day.temperature_2m_max) + '°';
    $('selectedLow').textContent = number(day.temperature_2m_min) + '°';
    $('selectedChance').textContent = number(day.precipitation_probability_max) + '%';
    $('selectedRain').textContent = amount(day.precipitation_sum) + ' mm expected';
    $('selectedWind').textContent = number(day.wind_speed_10m_max) + ' km/h';
    $('selectedGust').textContent = number(day.wind_gusts_10m_max) + ' km/h';
    const uv = day.uv_index_max;
    $('selectedUV').textContent = number(uv,1) + (uv === null ? '' : ' · ' + (uv<3?'Low':uv<6?'Moderate':uv<8?'High':uv<11?'Very high':'Extreme'));
    $('selectedSun').textContent = sunTime(day.sunrise) + ' / ' + sunTime(day.sunset);
    const isToday = localDate(day.time * 1000) === localDate(Date.now());
    const hours = isToday ? data.hourly.filter(row => row.time * 1000 >= Math.floor(Date.now()/3600000)*3600000).slice(0,24) : data.hourly.filter(row => localDate(row.time * 1000) === localDate(day.time * 1000));
    $('hourlyTitle').textContent = isToday ? 'The next 24 hours' : dayName(day.time) + ' · hour by hour';
    $('hourlyDescription').textContent = 'Temperature °C · hourly rain mm · chance % · wind km/h';
    renderHours(hours); $('hourlyScroll').scrollLeft = 0;
  }
  function renderHours(hours) {
    if (!hours.length) { $('hourlyChart').textContent = 'No more hourly readings for this day.'; $('hourlyReadings').replaceChildren(); return; }
    const column = 64, width = hours.length * column, chartHeight = 154;
    const temps = hours.map(h=>h.temperature_2m).filter(Number.isFinite);
    const lo = temps.length ? Math.min(...temps)-3 : 0, hi = temps.length ? Math.max(...temps)+3 : 1;
    const rainMax = Math.max(1,...hours.map(h=>h.precipitation).filter(Number.isFinite));
    const x = i=>i*column+column/2, y = t=>25+(hi-t)/(hi-lo)*70;
    let segments = [], segment = [];
    hours.forEach((h,i)=> { if (Number.isFinite(h.temperature_2m)) segment.push(`${x(i)},${y(h.temperature_2m)}`); else { if(segment.length)segments.push(segment); segment=[]; } });
    if (segment.length) segments.push(segment);
    const svg = `<svg width="${width}" height="${chartHeight}" viewBox="0 0 ${width} ${chartHeight}" role="img" aria-label="Hourly temperature line and rainfall bars. Exact readings in the table below."><line x1="0" y1="140" x2="${width}" y2="140" stroke="var(--border)"/>${hours.map((h,i)=>{
      const rainHeight=Number.isFinite(h.precipitation)?h.precipitation/rainMax*40:0;
      return `<rect x="${x(i)-12}" y="${140-rainHeight}" width="24" height="${rainHeight}" rx="3" fill="var(--rain)" opacity=".45"/>${Number.isFinite(h.temperature_2m)?`<text class="chart-temp" text-anchor="middle" x="${x(i)}" y="${y(h.temperature_2m)-12}">${number(h.temperature_2m)}°</text>`:''}`;
    }).join('')}${segments.map(points=>`<polyline points="${points.join(' ')}" fill="none" stroke="#d7aa60" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}</svg>`;
    $('hourlyChart').innerHTML = svg;
    const rows = [ ['Conditions',h=>`<span title="${weather(h.weather_code)[0]}">${icon(h.weather_code)}<span class="forecast-sr-only">${weather(h.weather_code)[0]}</span></span>`],
      ['Temperature °C',h=>number(h.temperature_2m)+'°'], ['Rain mm',h=>amount(h.precipitation)], ['Rain chance',h=>number(h.precipitation_probability)+'%'], ['Wind km/h',h=>number(h.wind_speed_10m)+' '+direction(h.wind_direction_10m)], ['Gust km/h',h=>number(h.wind_gusts_10m)] ];
    $('hourlyReadings').innerHTML = `<table class="hourly-table" style="width:${width+90}px"><caption class="forecast-sr-only">Hourly conditions, temperature, rainfall, chance of rain, wind and gusts.</caption><thead><tr><th scope="col">AEST</th>${hours.map(h=>`<th scope="col">${time(h.time*1000)}${new Intl.DateTimeFormat('en-AU',{timeZone:tz,hour:'2-digit',hourCycle:'h23'}).format(h.time*1000)==='00'?'<br>'+dayName(h.time):''}</th>`).join('')}</tr></thead><tbody>${rows.map(([label,format],i)=>`<tr class="${i===2||i===3?'hourly-rain':''}" ><th scope="row">${label}</th>${hours.map(h=>`<td aria-label="${label}: ${i===0?weather(h.weather_code)[0]:format(h)}">${format(h)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }
  function render() {
    const days = data.daily.filter(day=>localDate(day.time*1000)>=localDate(Date.now()));
    if (!days.length) throw Error('Forecast expired');
    $('forecastOverview').setAttribute('aria-busy','false');
    $('forecastWeek').innerHTML = days.map(day => `<button class="forecast-day" type="button" data-time="${day.time}" aria-pressed="false" aria-label="${date(day.time*1000)}, ${weather(day.weather_code)[0]}, high ${number(day.temperature_2m_max)} degrees, low ${number(day.temperature_2m_min)} degrees, ${number(day.precipitation_probability_max)} percent chance of rain"><span class="forecast-day-name">${dayName(day.time)}</span><span class="forecast-day-date">${new Intl.DateTimeFormat('en-AU',{timeZone:tz,day:'numeric',month:'short'}).format(day.time*1000)}</span>${icon(day.weather_code)}<span class="forecast-day-temps">${number(day.temperature_2m_max)}°<span>${number(day.temperature_2m_min)}°</span></span><span class="forecast-day-rain">${number(day.precipitation_probability_max)}% rain</span><span class="forecast-day-mm">${amount(day.precipitation_sum)} mm expected</span></button>`).join('');
    $('forecastWeek').querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>renderDay(days.find(day=>day.time===Number(button.dataset.time)))));
    renderDay(days.find(day=>day.time===selected) || days[0]);
  }
  async function load() {
    if (busy) return; busy=true; lastAttempt=Date.now(); $('refreshForecast').disabled=true;
    if (!data) status('Fetching the latest forecast…');
    try {
      const response=await fetch('/api/forecast',{cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(response.status===401) { location.assign('/login?next=%2Fforecast.html'); return; }
      if(!response.ok) throw Error('Feed unavailable');
      const incoming=await response.json();
      if(!Array.isArray(incoming.daily)||!incoming.daily.length||!Array.isArray(incoming.hourly)||!Number.isFinite(Date.parse(incoming.fetchedAt))) throw Error('Incomplete forecast');
      data=incoming; render();
      status((data.stale?'Showing the last available forecast · ':'Forecast fetched ') + time(Date.parse(data.fetchedAt)) + ' AEST · Open-Meteo',data.stale?'stale':'');
    } catch {
      if (data && Date.now()-Date.parse(data.fetchedAt)<6*3600000) { render(); status('Couldn’t refresh just now. Showing the forecast fetched '+time(Date.parse(data.fetchedAt))+' AEST.','stale'); }
      else { data=null; $('forecastOverview').hidden=true; $('forecastWeek').textContent='The seven-day outlook will return when the feed is available.'; $('hourlyChart').textContent='Hourly forecast unavailable.'; $('hourlyReadings').replaceChildren(); status('The forecast is taking a break. Please try Refresh forecast shortly.','error'); }
    } finally { if(data) $('forecastOverview').hidden=false; $('refreshForecast').disabled=false; busy=false; }
  }
  // Use the same saved portrait/landscape choice as Current and Daily Summary.
  function layout() {
    let choice; try { choice=localStorage.getItem('mooreWeatherDesktopLayout'); } catch {}
    if(!['portrait','landscape'].includes(choice)) choice=innerWidth>=900&&innerWidth>innerHeight?'landscape':'portrait';
    if(innerWidth<900) choice='portrait';
    document.body.classList.toggle('layout-landscape',choice==='landscape'); document.body.classList.toggle('layout-portrait',choice==='portrait');
    for(const mode of ['portrait','landscape']) { const button=$(mode+'LayoutBtn'); button?.classList.toggle('active',choice===mode); button?.setAttribute('aria-pressed',String(choice===mode)); }
  }
  window.setDesktopLayout=choice=> { try { localStorage.setItem('mooreWeatherDesktopLayout',choice); } catch {} layout(); };
  layout(); window.addEventListener('resize',layout);
  $('refreshForecast').addEventListener('click',load);
  function tick() { if(!document.hidden && Date.now()-lastAttempt>= (data?20*60000:60000)) load(); }
  document.addEventListener('visibilitychange',tick); setInterval(tick,60000); load();
})();
