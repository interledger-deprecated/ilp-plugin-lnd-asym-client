const DecodedLen = require("./zbase32").DecodedLen

const decodedLenTestData = {
    0: 0,
    1: 5,
    2: 5,
    3: 5,
    4: 5,
    5: 5,
    6: 5,
    7: 5,
    8: 5,
    9: 10,
    10: 10,
    11: 10,
    12: 10,
    13: 10,
    14: 10,
    15: 10,
    16: 10,
    17: 15,
    18: 15,
    19: 15,
}

for (var key in decodedLenTestData) {
  if (decodedLenTestData.hasOwnProperty(key)) {
    if (decodedLenTestData[key] !== DecodedLen(key)) {
        console.log("DecodedLen(", key, ")=", DecodedLen(key), ", want", decodedLenTestData[key])
        return
    }
  }
}