// Kho từ cho trò Vẽ và đoán chữ. Chỉ chọn từ vẽ được; mỗi mục cách nhau bằng dấu phẩy.
const list = (s: string) => s.split(',').map((w) => w.trim()).filter(Boolean);

export const WORDS = {
  vi: list(`
    con mèo, con chó, con gà, con vịt, con heo, con bò, con trâu, con ngựa, con dê, con thỏ, con chuột, con voi, con hổ, con sư tử, con khỉ,
    con gấu, gấu trúc, hươu cao cổ, ngựa vằn, cá sấu, con rắn, con rùa, con ếch, con cá, cá mập, cá voi, cá heo, con cua, con tôm, con mực,
    bạch tuộc, con ốc sên, con bướm, con ong, con kiến, con nhện, chuồn chuồn, con muỗi, con dơi, cú mèo, đại bàng, vẹt, chim cánh cụt,
    đà điểu, khủng long, con rồng, kỳ lân, chuột túi, con nhím, sao biển, con sứa,
    quả táo, quả chuối, quả cam, dưa hấu, quả dứa, quả nho, quả xoài, sầu riêng, quả dừa, đu đủ, quả dâu, quả ớt, quả bí ngô, cà rốt,
    bắp ngô, cà chua, củ hành, nấm, bánh mì, phở, bánh chưng, bánh xèo, gỏi cuốn, cơm tấm, bún chả, trà sữa, cà phê, kem, bánh sinh nhật,
    kẹo mút, bánh pizza, hamburger, trứng ốp la, xúc xích, bỏng ngô, nước mía,
    cái bàn, cái ghế, cái giường, cái tủ, cái đèn, quạt máy, ti vi, tủ lạnh, máy giặt, điện thoại, máy tính, bàn phím, tai nghe, máy ảnh,
    đồng hồ, cái ô, cái nón lá, mũ bảo hiểm, mắt kính, đôi giày, đôi dép, áo dài, cái váy, cà vạt, ba lô, ví tiền, chìa khóa, ổ khóa,
    cái kéo, bút chì, cây thước, quyển sách, cục tẩy, bóng đèn, ngọn nến, bật lửa, cái chổi, cái gương, bàn chải, cây lược, đôi đũa,
    cái thìa, cái nĩa, con dao, cái nồi, cái chảo, cái ly, ấm trà, cái búa, cái cưa, cái thang, cái cuốc, lưỡi câu, la bàn, kính lúp,
    kính thiên văn, đàn ghi ta, đàn piano, cái trống, cây sáo, micro, quả bóng bay, con diều, gấu bông, xúc xắc,
    xe đạp, xe máy, xe hơi, xe buýt, xe tải, xe cứu thương, xe cứu hỏa, xe lửa, máy bay, trực thăng, tàu thủy, thuyền buồm, tàu ngầm,
    tên lửa, khinh khí cầu, xích lô, đèn giao thông, cây xăng,
    ngôi nhà, trường học, bệnh viện, nhà thờ, ngôi chùa, lâu đài, kim tự tháp, cây cầu, ngọn hải đăng, cối xay gió, công viên, sân bóng,
    hồ bơi, rạp xiếc, siêu thị, nhà sàn, cái lều, chợ nổi, ruộng bậc thang,
    mặt trời, mặt trăng, ngôi sao, đám mây, cơn mưa, cầu vồng, tia sét, bông tuyết, cơn lốc, núi lửa, ngọn núi, thác nước, dòng sông,
    bãi biển, hòn đảo, sa mạc, cây dừa, cây tre, cây thông, hoa sen, hoa hồng, hoa hướng dương, xương rồng, chiếc lá, ngọn lửa,
    bác sĩ, giáo viên, công an, lính cứu hỏa, đầu bếp, phi hành gia, nông dân, ca sĩ, họa sĩ, chú hề, ông già Noel, cướp biển, ninja,
    ma cà rồng, xác ướp, người ngoài hành tinh, người tuyết, nàng tiên cá, phù thủy, siêu nhân,
    đá bóng, bơi lội, cầu lông, bóng rổ, bóng chuyền, câu cá, nhảy dây, leo núi, trượt ván, lướt sóng, cử tạ, bắn cung, đua xe, thả diều,
    cắm trại, chụp ảnh, đánh răng, ngủ gật, hắt xì, khóc nhè, tập thể dục, nấu ăn, tưới cây, rửa bát, kéo co, múa lân,
    trái tim, vương miện, kho báu, bản đồ, lá cờ, quà tặng, pháo hoa, đèn lồng, bao lì xì, bộ xương, bộ não, bàn tay, dấu chân,
    râu mép, tóc xoăn, mạng nhện, tổ chim, quả trứng, cục pin, nam châm, thùng rác, cái neo, huy chương
  `),
  en: list(`
    cat, dog, chicken, duck, pig, cow, horse, goat, rabbit, mouse, elephant, tiger, lion, monkey, bear, panda, giraffe, zebra, crocodile,
    snake, turtle, frog, fish, shark, whale, dolphin, crab, shrimp, squid, octopus, snail, butterfly, bee, ant, spider, dragonfly,
    mosquito, bat, owl, eagle, parrot, penguin, ostrich, dinosaur, dragon, unicorn, kangaroo, hedgehog, starfish, jellyfish,
    apple, banana, orange, watermelon, pineapple, grapes, mango, coconut, strawberry, pepper, pumpkin, carrot, corn, tomato, onion,
    mushroom, bread, noodles, coffee, ice cream, birthday cake, lollipop, pizza, hamburger, fried egg, hot dog, popcorn, sandwich,
    donut, cheese, cookie,
    table, chair, bed, wardrobe, lamp, fan, television, fridge, washing machine, phone, computer, keyboard, headphones, camera, clock,
    umbrella, hat, helmet, glasses, shoes, slippers, dress, necktie, backpack, wallet, key, padlock, scissors, pencil, ruler, book,
    eraser, light bulb, candle, lighter, broom, mirror, toothbrush, comb, chopsticks, spoon, fork, knife, pot, frying pan, glass,
    teapot, hammer, saw, ladder, shovel, fish hook, compass, magnifying glass, telescope, guitar, piano, drum, flute, microphone,
    balloon, kite, teddy bear, dice,
    bicycle, motorbike, car, bus, truck, ambulance, fire truck, train, airplane, helicopter, ship, sailboat, submarine, rocket,
    hot air balloon, traffic light, gas station,
    house, school, hospital, church, temple, castle, pyramid, bridge, lighthouse, windmill, park, stadium, swimming pool, circus,
    supermarket, tent,
    sun, moon, star, cloud, rain, rainbow, lightning, snowflake, tornado, volcano, mountain, waterfall, river, beach, island, desert,
    palm tree, bamboo, pine tree, lotus, rose, sunflower, cactus, leaf, campfire,
    doctor, teacher, police officer, firefighter, chef, astronaut, farmer, singer, painter, clown, Santa Claus, pirate, ninja,
    vampire, mummy, alien, snowman, mermaid, witch, superhero,
    football, swimming, badminton, basketball, volleyball, fishing, skipping rope, climbing, skateboard, surfing, weightlifting,
    archery, camping, sneeze, sleeping, cooking, dancing,
    heart, crown, treasure, map, flag, gift, fireworks, lantern, skeleton, brain, hand, footprint, moustache, spider web, bird nest,
    egg, battery, magnet, trash can, anchor, medal
  `),
} as const;

export type WordLang = keyof typeof WORDS;
