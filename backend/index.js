const express = require('express');
const axios = require('axios');
const cors = require('cors');
const qs = require('querystring');
const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

function buildOverpassQuery(coords, preferences) {
  const radius = 3000; // Increased radius for broader match
  let queryParts = [];

  coords.forEach(([lat, lon]) => {
    preferences.forEach(pref => {
      queryParts.push(`node["amenity"="${pref}"](around:${radius},${lat},${lon});`);
    });
  });

  return `
    [out:json];
    (
      ${queryParts.join('\n')}
    );
    out center;
  `;
}

function interpolateRoute(startCoords, endCoords, distanceKm = 10) {
  const R = 6371;
  const toRad = angle => angle * (Math.PI / 180);

  const [lat1, lon1] = startCoords;
  const [lat2, lon2] = endCoords;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const totalDistance = R * c;

  const numPoints = Math.max(3, Math.floor(totalDistance / distanceKm));
  const points = [];

  for (let i = 0; i <= numPoints; i++) {
    const lat = lat1 + (lat2 - lat1) * (i / numPoints);
    const lon = lon1 + (lon2 - lon1) * (i / numPoints);
    points.push([lat, lon]);
  }

  return points;
}

function selectSmartStops(stops, route, preferences) {
  if (stops.length === 0) return [];

  stops.forEach(stop => {
    stop.score = 0;
    stop.matchedPreferences = [];

    preferences.forEach(pref => {
      if (stop.tags) {
        const tags = stop.tags;

        if (tags.amenity === pref && !stop.matchedPreferences.includes(pref)) {
          stop.score++;
          stop.matchedPreferences.push(pref);
        }

        if (pref === 'toilets' && tags.toilets === 'yes' && !stop.matchedPreferences.includes('toilets')) {
          stop.score++;
          stop.matchedPreferences.push('toilets');
        }

        if (pref === 'restaurant' && tags.cuisine && !stop.matchedPreferences.includes('restaurant')) {
          stop.score++;
          stop.matchedPreferences.push('restaurant');
        }

        if (pref === 'food' && tags.cuisine && !stop.matchedPreferences.includes('food')) {
          stop.score++;
          stop.matchedPreferences.push('food');
        }

        if (pref === 'fuel' && (tags.amenity === 'fuel' || tags.shop === 'convenience') && !stop.matchedPreferences.includes('fuel')) {
          stop.score++;
          stop.matchedPreferences.push('fuel');
        }
      }
    });
  });

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  const bestStops = [];
  const usedIndices = new Set();

  route.forEach(([rLat, rLon], idx) => {
    let best = null;
    let bestScore = -1;
    let minDist = Infinity;

    for (let stop of stops) {
      const dist = haversine(rLat, rLon, stop.lat, stop.lon);
      if (dist <= 5 && (stop.score > bestScore || (stop.score === bestScore && dist < minDist))) {
        best = stop;
        bestScore = stop.score;
        minDist = dist;
      }
    }

    if (best && !usedIndices.has(best.name + best.lat + best.lon)) {
      bestStops.push(best);
      usedIndices.add(best.name + best.lat + best.lon);
    }
  });

  return bestStops;
}

app.post('/plan-trip', async (req, res) => {
  const { start, end, preferences } = req.body;

  try {
    const startGeo = await axios.get(`https://nominatim.openstreetmap.org/search`, {
      params: { q: start, format: 'json', limit: 1 },
      headers: { 'User-Agent': 'trip-planner-app' }
    });

    const endGeo = await axios.get(`https://nominatim.openstreetmap.org/search`, {
      params: { q: end, format: 'json', limit: 1 },
      headers: { 'User-Agent': 'trip-planner-app' }
    });

    if (!startGeo.data.length || !endGeo.data.length) {
      return res.status(400).send("Unable to geocode city names.");
    }

    const startCoords = [
      parseFloat(startGeo.data[0].lat),
      parseFloat(startGeo.data[0].lon)
    ];
    const endCoords = [
      parseFloat(endGeo.data[0].lat),
      parseFloat(endGeo.data[0].lon)
    ];

    const route = interpolateRoute(startCoords, endCoords, 10); // ~10 km segments
    const query = buildOverpassQuery(route, preferences);
    const queryString = qs.stringify({ data: query });

    const response = await axios.post('https://overpass-api.de/api/interpreter', queryString, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    console.log('Overpass response count:', response.data.elements.length);

    const rawStops = response.data.elements.map(el => ({
      lat: el.lat,
      lon: el.lon,
      name: el.tags?.name || el.tags?.amenity || 'Stop',
      type: el.tags?.amenity || 'unknown',
      tags: el.tags || {}
    }));

    const smartStops = selectSmartStops(rawStops, route, preferences);

    res.json({ route, stops: smartStops });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).send("Error processing trip plan");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
