// ============================================================================
// Planners Dashboard — Shared working-calendar math (PDCal)
// ----------------------------------------------------------------------------
// Used by the resource-loading module (Calendars tab) and the project-schedule
// module (FTE / Max-Availability histogram) to answer "is this date a working
// day, and how many working hours does a calendar give us in this period."
//
// A calendar row (from the `calendars` table) is a weekday work-pattern +
// hours/day + an editable extra-holiday list. Philippine *regular* holidays
// with fixed or Easter-derived dates are computed here rather than stored —
// only Eid'l Fitr/Eid'l Adha and any ad-hoc proclamation-moved dates need to
// go in a calendar's extra_holidays, since those are announced yearly by the
// Philippine government and can't be computed offline.
// ============================================================================

(function (global) {
  'use strict';

  function iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // Anonymous Gregorian algorithm (Meeus/Jones/Butcher) — used for Maundy
  // Thursday / Good Friday, which are defined relative to Easter Sunday.
  function easterSunday(y) {
    var a = y % 19, b = Math.floor(y / 100), c = y % 100;
    var d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    var g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    var i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
    var m = Math.floor((a + 11 * h + 22 * l) / 451);
    var month = Math.floor((h + l - 7 * m + 114) / 31);
    var day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(y, month - 1, day);
  }
  function lastMondayOfAugust(y) {
    var d = new Date(y, 8, 0);           // last day of August
    var back = (d.getDay() + 6) % 7;     // days back to the preceding Monday
    d.setDate(d.getDate() - back);
    return d;
  }

  // Philippine *regular* holidays (RA 9849 + standing proclamations) that fall
  // on a fixed or Easter-derived date every year. Does NOT include Eid'l Fitr /
  // Eid'l Adha (lunar, announced yearly) or ad-hoc proclamation-moved dates —
  // add those to a calendar's extra_holidays instead.
  var _cache = {};
  function phRegularHolidays(y) {
    if (_cache[y]) return _cache[y];
    var easter = easterSunday(y);
    var maundy = new Date(easter); maundy.setDate(easter.getDate() - 3);
    var good = new Date(easter); good.setDate(easter.getDate() - 2);
    var dates = [
      new Date(y, 0, 1),    // New Year's Day
      maundy,               // Maundy Thursday
      good,                 // Good Friday
      new Date(y, 3, 9),    // Araw ng Kagitingan
      new Date(y, 4, 1),    // Labor Day
      new Date(y, 5, 12),   // Independence Day
      lastMondayOfAugust(y),// National Heroes Day
      new Date(y, 10, 30),  // Bonifacio Day
      new Date(y, 11, 25),  // Christmas Day
      new Date(y, 11, 30)   // Rizal Day
    ];
    var set = {};
    dates.forEach(function (d) { set[iso(d)] = true; });
    return (_cache[y] = set);
  }

  var WD_KEYS = ['work_sun', 'work_mon', 'work_tue', 'work_wed', 'work_thu', 'work_fri', 'work_sat'];

  // The one supported calendar shape when a resource/activity has none assigned
  // yet: 6-day week (Mon–Sat), 8 hours/day, PH regular holidays off.
  function defaultCalendar() {
    return {
      name: 'Philippine Standard (6-day, 8h)', hours_per_day: 8,
      work_mon: true, work_tue: true, work_wed: true, work_thu: true, work_fri: true, work_sat: true, work_sun: false,
      extra_holidays: []
    };
  }

  function isWorkDay(cal, date) {
    cal = cal || defaultCalendar();
    if (!cal[WD_KEYS[date.getDay()]]) return false;
    var ds = iso(date);
    if (phRegularHolidays(date.getFullYear())[ds]) return false;
    if (cal.extra_holidays && cal.extra_holidays.indexOf(ds) !== -1) return false;
    return true;
  }

  function workingDaysInRange(cal, start, end) {
    var n = 0, d = new Date(start);
    for (; d <= end; d.setDate(d.getDate() + 1)) if (isWorkDay(cal, d)) n++;
    return n;
  }

  function workingDaysInMonth(cal, y, mo) {
    return workingDaysInRange(cal, new Date(y, mo, 1), new Date(y, mo + 1, 0));
  }

  global.PDCal = {
    phRegularHolidays: phRegularHolidays,
    defaultCalendar: defaultCalendar,
    isWorkDay: isWorkDay,
    workingDaysInRange: workingDaysInRange,
    workingDaysInMonth: workingDaysInMonth,
    iso: iso
  };
})(window);
