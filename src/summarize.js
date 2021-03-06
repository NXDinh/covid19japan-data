// Summarizes data for site.
const _ = require('lodash')
const moment = require('moment')
const Papa = require('papaparse')
const fs = require('fs')

const verify = require('./verify.js')

const CRUISE_PASSENGER_DISEMBARKED = /^Cruise Disembarked Passenger/

const allPrefectures = () => {
  let prefecturesCsv = fs.readFileSync('./src/statusboard/prefectures.csv', 'utf8')
  let prefecturesList = Papa.parse(prefecturesCsv, {header: true})
  return _.map(prefecturesList.data, o => o.prefecture_en)
}

// Merge all the data from the spreadsheet with auto-calculation
//
// patientData: Output generated by fetchPatientData
// manualDailyData: List of rows from the Sum By Day spreadsheet.
// manualPrefectureData: List of rows from the Prefecture Data spreadsheet
// lastUpdated: String representing when the data was last updated.
//
// @returns A dictionary with the prefecture and daily summaries.
const summarize = (patientData, manualDailyData, manualPrefectureData, cruiseCounts, lastUpdated) => {
  const patients = _.orderBy(patientData, ['dateAnnounced'], ['asc'])
  let prefectureSummary = generatePrefectureSummary(patients, manualPrefectureData, cruiseCounts)
  let dailySummary = generateDailySummary(patients, manualDailyData, cruiseCounts)

  return {
    prefectures: prefectureSummary,
    daily: dailySummary,
    updated: lastUpdated
  }
}


// Helper method to do parseInt safely (reverts to 0 if unparse)
const safeParseInt = v => {
  let result = parseInt(v)
  if (isNaN(result)) {
    return 0
  }
  return result
}

const DAILY_SUMMARY_TEMPLATE = {
  confirmed: 0,
  confirmedCumulative: 0,
  deceased: 0,
  deceasedCumulative: 0,
  recovered: 0,
  recoveredCumulative: 0,
  critical: 0,
  criticalCumulative: 0,
  tested: 0,
  testedCumulative: 0,
  active: 0,
  activeCumulative: 0,
  cruiseConfirmedCumulative: 0,
  cruiseDeceasedCumulative: 0,
  cruiseRecoveredCumulative: 0,
  cruiseTestedCumulative: 0,
  cruiseCriticalCumulative: 0,
}

// Generates the daily summary
const generateDailySummary = (patients, manualDailyData, cruiseCounts) => {
  let dailySummary = {}
  for (let patient of patients) {
    let dateAnnounced = patient.dateAnnounced
    if (!patient.dateAnnounced) {
      continue
    }
   
    if (patient.confirmedPatient) {
      if (!dailySummary[dateAnnounced]) {
        dailySummary[dateAnnounced] = _.assign({}, DAILY_SUMMARY_TEMPLATE)
      } 
      dailySummary[dateAnnounced].confirmed += 1
    }
    if (patient.patientStatus == 'Deceased') {
      let dateDeceased = patient.deceasedDate
      if (dateDeceased) {
        if (!dailySummary[dateDeceased]) {
          dailySummary[dateDeceased] = _.assign({}, DAILY_SUMMARY_TEMPLATE)
        } 
        dailySummary[dateDeceased].deceased += 1
      }
    }
  }

  // merge manually sourced data
  // TODO: critical should be pulled out of our patient
  //       data. But those numbers are incomplete.
  for (let row of manualDailyData) {
    if (dailySummary[row.date]) {
      dailySummary[row.date].recoveredCumulative = safeParseInt(row.recovered)
      dailySummary[row.date].criticalCumulative = safeParseInt(row.critical)
      dailySummary[row.date].testedCumulative = safeParseInt(row.tested)
    }
  }

  // merge cruise ship data
  for (let row of cruiseCounts) {
    if (dailySummary[row.date]) {
      dailySummary[row.date].cruiseConfirmedCumulative = safeParseInt(row.dpConfirmed) + safeParseInt(row.nagasakiConfirmed)
      dailySummary[row.date].cruiseCriticalCumulative = safeParseInt(row.dpCritical) + safeParseInt(row.nagasakiCritical)
      dailySummary[row.date].cruiseTestedCumulative = safeParseInt(row.dpTested) + safeParseInt(row.nagasakiTested)
      dailySummary[row.date].cruiseDeceasedCumulative = safeParseInt(row.dpDeceased) + safeParseInt(row.nagasakiDeceased)
      dailySummary[row.date].cruiseRecoveredCumulative = safeParseInt(row.dpRecovered) + safeParseInt(row.nagasakiRecovered)
    }
  }

  let orderedDailySummary = 
      _.map(_.sortBy(_.toPairs(dailySummary), a => a[0]), (v) => { let o = v[1]; o.date = v[0]; return o })
  
  // Calculate the cumulative and incremental numbers by iterating through all the days in order
  let confirmedCumulative = 0
  let deceasedCumulative = 0

  for (let dailySum of orderedDailySummary) {
    // confirmed.
    confirmedCumulative += dailySum.confirmed
    dailySum.confirmedCumulative = confirmedCumulative
    // deceased
    deceasedCumulative += dailySum.deceased
    dailySum.deceasedCumulative = deceasedCumulative
  }  

  const cumulativeKeys = [
    'recoveredCumulative',
    'deceasedCumulative',
    'criticalCumulative',
    'testedCumulative',
    'cruiseConfirmedCumulative',
    'cruiseDeceasedCumulative',
    'cruiseCriticalCumulative',
    'cruiseTestedCumulative',
    'cruiseRecoveredCumulative'
  ]
  // For dates we don't have any manually entered data, pass those forward.
  for (let i = 1; i < orderedDailySummary.length; i++) {
    let thisDay = orderedDailySummary[i]
    let previousDay = orderedDailySummary[i-1]
    for (let key of cumulativeKeys) {
      if (thisDay[key] == 0) {
        thisDay[key] = previousDay[key]
      }
    }
  }

  // Calculate active/activeCumulative (must happen after we bring forward any missing cumulative numbers)
  for (let dailySum of orderedDailySummary) {
    dailySum.activeCumulative = dailySum.confirmedCumulative - dailySum.deceasedCumulative - dailySum.recoveredCumulative
  }

  // Calculate daily incrementals that we're missing by using the cumulative numbers.
  let yesterdayTestedCumulative = 0
  let yesterdayRecoveredCumulative = 0
  let yesterdayCriticalCumulative = 0
  let yesterdayActiveCumulative = 0
  for (let dailySum of orderedDailySummary) {
    // tested
    dailySum.tested = dailySum.testedCumulative - yesterdayTestedCumulative
    yesterdayTestedCumulative = dailySum.testedCumulative
    // recovered
    dailySum.recovered = dailySum.recoveredCumulative - yesterdayRecoveredCumulative
    yesterdayRecoveredCumulative = dailySum.recoveredCumulative
    // critical
    dailySum.critical = dailySum.criticalCumulative - yesterdayCriticalCumulative
    yesterdayCriticalCumulative = dailySum.criticalCumulative
    // active
    dailySum.active = dailySum.activeCumulative - yesterdayActiveCumulative
    yesterdayActiveCumulative = dailySum.activeCumulative

  }

  // For backwards compatibility, include deaths field. (Remove after 5/1)
  for (let i = 1; i < orderedDailySummary.length; i++) {
    let thisDay = orderedDailySummary[i]
    thisDay.deaths = thisDay.deceased
  }

  // Calculate a rolling 3/7 day average for confirmed.
  let threeDayBuffer = []
  let sevenDayBuffer = []
  let confirmedCumulativeAvg3d = 0
  let confirmedCumulativeAvg7d = 0
  for (let dailySum of orderedDailySummary) {
    threeDayBuffer.push(dailySum.confirmed)
    sevenDayBuffer.push(dailySum.confirmed)
    if (threeDayBuffer.length > 3) {
      threeDayBuffer = threeDayBuffer.slice(threeDayBuffer.length - 3)
    }
    if (sevenDayBuffer.length > 7) {
      sevenDayBuffer = sevenDayBuffer.slice(sevenDayBuffer.length - 7) 
    }
    dailySum.confirmedAvg3d = Math.floor(_.sum(threeDayBuffer) / 3)
    confirmedCumulativeAvg3d += dailySum.confirmedAvg3d
    dailySum.confirmedCumulativeAvg3d = confirmedCumulativeAvg3d

    dailySum.confirmedAvg7d = Math.floor(_.sum(sevenDayBuffer) / 7)
    confirmedCumulativeAvg7d += dailySum.confirmedAvg7d
    dailySum.confirmedCumulativeAvg7d = confirmedCumulativeAvg7d
  }

  orderedDailySummary = verify.verifyDailySummary(orderedDailySummary)
  return orderedDailySummary
}




const PREFECTURE_SUMMARY_TEMPLATE = {
  confirmed: 0,
  dailyConfirmedCount: [],
  dailyConfirmedStartDate: null,
  newlyConfirmed: 0,
  yesterdayConfirmed: 0,
  dailyDeceasedCount: [],
  dailyDeceasedStartDate: null,
  deceased: 0,
  cruisePassenger: 0,
  recovered: 0,
  critical: 0,
  tested: 0,

  // These need to be separately reset ...
  patients: [],
  confirmedByCity: {},
}

// Generate the per-prefecture summary, ordered by number of confirmed cases.
//
// patients: Patients data from Patient Data spreadsheet.
// manualPrefectureData: List of rows from the prefecture spreadsheet.
//
// @returns prefectureSummary as a dictionary.
const generatePrefectureSummary = (patients, manualPrefectureData, cruiseCounts) => {
  let prefectureSummary = {}

  for (let patient of patients) {
    let prefectureName = patient.detectedPrefecture
    let cityName = patient.detectedCityTown

    if (typeof prefectureSummary[prefectureName] === 'undefined') {
      prefectureSummary[prefectureName] = _.assign({}, PREFECTURE_SUMMARY_TEMPLATE)
      prefectureSummary[prefectureName].patients = []
      prefectureSummary[prefectureName].confirmedByCity = {}
    }

    if (patient.confirmedPatient) {
      prefectureSummary[prefectureName].confirmed += 1
      if (cityName) {
        if (prefectureSummary[prefectureName].confirmedByCity[cityName]) {
          prefectureSummary[prefectureName].confirmedByCity[cityName] += 1
        } else {
          prefectureSummary[prefectureName].confirmedByCity[cityName] = 1        
        }
      }

      if (patient.knownCluster && CRUISE_PASSENGER_DISEMBARKED.test(patient.knownCluster)) {
        prefectureSummary[prefectureName].cruisePassenger += 1
      }
    }

    if (patient.patientStatus == 'Deceased') {
      prefectureSummary[prefectureName].deceased += 1
    }

    prefectureSummary[prefectureName].patients.push(patient)
  }

  for (let prefectureName of _.keys(prefectureSummary)) {
    let prefecture = prefectureSummary[prefectureName]
    const firstDay = moment('2020-01-08')
    const daily = generateDailyStatsForPrefecture(prefecture.patients, firstDay)
    if (daily.confirmed && daily.confirmed.length) {
      prefecture.dailyConfirmedCount = daily.confirmed
      prefecture.dailyConfirmedStartDate = firstDay.format('YYYY-MM-DD')
      prefecture.newlyConfirmed = daily.confirmed[daily.confirmed.length - 1]
      if (daily.confirmed.length > 2) {
        prefecture.yesterdayConfirmed = daily.confirmed[daily.confirmed.length - 2]
      }
    }
    if (daily.deaths && daily.deaths.length) {
      prefecture.dailyDeceasedCount = daily.deaths
      prefecture.dailyDeceasedStartDate = firstDay.format('YYYY-MM-DD')
      prefecture.newlyDeceased = daily.deaths[daily.deaths.length - 1]
      if (daily.deaths.length > 2) {
        prefecture.yesterdayDeceased = daily.deaths[daily.deaths.length - 2]
      }
    }
  }

  // Import manual data.
  for (let row of manualPrefectureData) {
    if (prefectureSummary[row.prefecture]) {
      prefectureSummary[row.prefecture].recovered = safeParseInt(row.recovered)
      prefectureSummary[row.prefecture].name_ja = row.prefectureJa
    }
  }

  // Strip out patients list
  prefectureSummary = _.mapValues(prefectureSummary, (v) => { 
    let stripped = _.omit(v, 'patients')
    return stripped 
  })

  // Incorporate cruise ship patients.
  if (cruiseCounts) {
    let cruiseSummaries = generateCruiseShipPrefectureSummary(cruiseCounts)    
    prefectureSummary['Nagasaki Cruise Ship'] = cruiseSummaries.nagasakiCruise
    prefectureSummary['Diamond Princess Cruise Ship'] = cruiseSummaries.diamondPrincess
  }

  const prefecturesEn = allPrefectures()

  // Mark pseudo-prefectures as such (e.g. Unspecified, Port of Entry, Diamond Princess, Nagasaki Cruise Ship)
  prefectureSummary = _.mapValues(prefectureSummary, (v, k) => {
    if (prefecturesEn.indexOf(k) == -1) {
      v.pseudoPrefecture = true
    }
    return v
  })

  // Backwards-compatiblilty deaths -> deceased (remove after 5/1)
  prefectureSummary = _.mapValues(prefectureSummary, (v, k) => {
    v.deaths = v.deceased
    return v
  })


  return _.map(
    _.reverse(
      _.sortBy(
        _.toPairs(prefectureSummary), 
        [ a => a[1].confirmed ])),
    (v) => { let o = v[1]; o.name = v[0]; return o }
  )
}

// Generates pseudo prefecture summaries for cruise passengers.
const generateCruiseShipPrefectureSummary = (cruiseCounts) => {
  let diamondPrincess = _.assign({}, PREFECTURE_SUMMARY_TEMPLATE)
  diamondPrincess.name = 'Diamond Princess Cruise Ship'
  diamondPrincess.name_ja = 'ダイヤモンド・プリンセス'
  let nagasakiCruise = _.assign({}, PREFECTURE_SUMMARY_TEMPLATE)
  nagasakiCruise.name = 'Nagasaki Cruise Ship'
  nagasakiCruise.name_ja = '長崎のクルーズ船'

  let diamondPrincessConfirmedCounts = [0]
  let diamondPrincessDeceasedCounts = [0]
  let nagasakiConfirmedCounts = [0]
  let nagasakiDeceasedCounts = [0]
  let diamondPrincessLastConfirmed = 0
  let diamondPrincessLastDeceased = 0
  let nagasakiLastConfirmed = 0
  let nagasakiLastDeceased = 0


  // Generate per-day increment data.
  const firstDay = moment('2020-02-04')
  const lastDay = moment().utcOffset(540)
  let day = moment(firstDay)
  let cruiseCountsByDay = _.fromPairs(_.map(cruiseCounts, o => { return [o.date, o] }))

  while (day <= lastDay) {
    let dateString = day.format('YYYY-MM-DD')
    let row = cruiseCountsByDay[dateString]
    if (row) {
      if (row.dpConfirmed) {
        let diff = safeParseInt(row.dpConfirmed) - diamondPrincessLastConfirmed
        diamondPrincessLastConfirmed = safeParseInt(row.dpConfirmed)
        diamondPrincessConfirmedCounts.push(diff)
      } else {
        diamondPrincessConfirmedCounts.push(0)
      }
      if (row.dpDeceased) {
        let diff = safeParseInt(row.dpDeceased) - diamondPrincessLastDeceased
        diamondPrincessLastDeceased = safeParseInt(row.dpDeceased)
        diamondPrincessDeceasedCounts.push(diff)
      } else {
        diamondPrincessDeceasedCounts.push(0)
      }    
      if (row.nagasakiConfirmed) {
        let diff = safeParseInt(row.nagasakiConfirmed) - nagasakiLastConfirmed
        nagasakiLastConfirmed = safeParseInt(row.nagasakiConfirmed)
        nagasakiConfirmedCounts.push(diff)
      } else {
        nagasakiConfirmedCounts.push(0)
      }
      if (row.nagasakiDeceased) {
        let diff = safeParseInt(row.nagasakiDeceased) - nagasakiLastDeceased
        nagasakiLastDeceased = safeParseInt(row.nagasakiDeceased)
        nagasakiDeceasedCounts.push(diff)
      } else {
        nagasakiDeceasedCounts.push(0)
      }
    } else {
      // no data.
      diamondPrincessConfirmedCounts.push(0)
      diamondPrincessDeceasedCounts.push(0)
      nagasakiConfirmedCounts.push(0)
      nagasakiDeceasedCounts.push(0)
    }
    day = day.add(1, 'day')
  }

  diamondPrincess.dailyConfirmedCount = diamondPrincessConfirmedCounts
  diamondPrincess.dailyConfirmedStartDate = firstDay.format('YYYY-MM-DD')
  diamondPrincess.dailyDeceasedCount = diamondPrincessDeceasedCounts
  diamondPrincess.dailyDeceasedStartDate = firstDay.format('YYYY-MM-DD')
  nagasakiCruise.dailyConfirmedCount = nagasakiConfirmedCounts
  nagasakiCruise.dailyConfirmedStartDate = firstDay.format('YYYY-MM-DD')
  nagasakiCruise.dailyDeceasedCount = nagasakiDeceasedCounts
  nagasakiCruise.dailyDeceasedStartDate = firstDay.format('YYYY-MM-DD')

  diamondPrincess.newlyConfirmed = diamondPrincessConfirmedCounts[diamondPrincessConfirmedCounts.length - 1]
  if (diamondPrincessConfirmedCounts.length > 2) {
    diamondPrincess.yesterdayConfirmed = diamondPrincessConfirmedCounts[diamondPrincessConfirmedCounts.length - 2]
  }

  diamondPrincess.newlyDeceased = diamondPrincessDeceasedCounts[diamondPrincessDeceasedCounts.length - 1]
  if (diamondPrincessDeceasedCounts.length > 2) {
    diamondPrincess.newlyDeceased = diamondPrincessDeceasedCounts[diamondPrincessDeceasedCounts.length - 2]
  }

  nagasakiCruise.newlyConfirmed = nagasakiConfirmedCounts[nagasakiConfirmedCounts.length - 1]
  if (nagasakiConfirmedCounts.length > 2) {
    nagasakiCruise.yesterdayConfirmed = nagasakiConfirmedCounts[nagasakiConfirmedCounts.length - 2]
  }

  nagasakiCruise.newlyDeceased = nagasakiDeceasedCounts[nagasakiDeceasedCounts.length - 1]
  if (nagasakiDeceasedCounts.length > 2) {
    nagasakiCruise.newlyDeceased = nagasakiDeceasedCounts[nagasakiDeceasedCounts.length - 2]
  }


  // Take the last row of data and use that as the total for the prefecture.
  const latestRow = _.last(cruiseCounts)
  diamondPrincess.confirmed = safeParseInt(latestRow.dpConfirmed)
  diamondPrincess.recovered = safeParseInt(latestRow.dpRecovered)
  diamondPrincess.deceased = safeParseInt(latestRow.dpDeceased)
  diamondPrincess.critical = safeParseInt(latestRow.dpCritical)
  diamondPrincess.tested = safeParseInt(latestRow.dpTested)
  nagasakiCruise.confirmed = safeParseInt(latestRow.nagasakiConfirmed)
  nagasakiCruise.recovered = safeParseInt(latestRow.nagasakiRecovered)
  nagasakiCruise.deceased = safeParseInt(latestRow.nagasakiDeceased)
  nagasakiCruise.critical = safeParseInt(latestRow.nagasakiCritical)
  nagasakiCruise.tested = safeParseInt(latestRow.nagasakiTested)

  return {diamondPrincess: diamondPrincess, nagasakiCruise: nagasakiCruise}
}

const generateDailyStatsForPrefecture = (patients, firstDay) => {
  const lastDay = moment().utcOffset(540)
  let day = moment(firstDay)
  let dailyConfirmed= []
  let dailyDeaths = []
  while (day <= lastDay) {
    let dayString = day.format('YYYY-MM-DD')
    let confirmed = _.filter(patients, o => { return o.dateAnnounced == dayString && o.confirmedPatient})
    dailyConfirmed.push(confirmed.length)
    let deaths = _.filter(patients, o => { return o.deceasedDate == dayString && o.patientStatus == 'Deceased'})
    dailyDeaths.push(deaths.length)
    day = day.add(1, 'days')
  }
  return {confirmed: dailyConfirmed, deaths: dailyDeaths}
}

exports.summarize = summarize;

