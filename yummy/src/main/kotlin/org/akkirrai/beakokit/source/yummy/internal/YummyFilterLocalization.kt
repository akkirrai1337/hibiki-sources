package org.akkirrai.beakokit.source.yummy.internal

/** Human-readable labels for the raw filter aliases YummyAnime's API reports. */
internal fun localizeYummySortFilterLabel(alias: String, preferEnglish: Boolean): String {
    val label = when (alias.lowercase()) {
        "relevance" -> "Релевантности" to "Relevance"
        "top", "rating" -> "Рейтингу" to "Rating"
        "title" -> "Названию" to "Title"
        "year" -> "Дате выхода" to "Release date"
        "rating_counters" -> "Количеству оценок" to "Rating count"
        "votes" -> "Голосам" to "Votes"
        "views" -> "Просмотрам" to "Views"
        "comments" -> "Комментариям" to "Comments"
        "random" -> "Случайно" to "Random"
        "id" -> "Сначала новые" to "Newest added"
        else -> null
    } ?: return formatFallbackFilterLabel(alias, preferEnglish)
    return if (preferEnglish) label.second else label.first
}

internal fun localizeYummyTypeFilterLabel(alias: String, preferEnglish: Boolean): String {
    val label = when (alias.lowercase()) {
        "tv" -> "Сериал" to "Series"
        "movie" -> "Полнометражный фильм" to "Feature film"
        "short_movie" -> "Короткометражный фильм" to "Short film"
        "ova" -> "OVA" to "OVA"
        "special" -> "Спэшл" to "Special"
        "short_serial" -> "Малометражный сериал" to "Short series"
        "ona" -> "ONA" to "ONA"
        else -> null
    } ?: return formatFallbackFilterLabel(alias, preferEnglish)
    return if (preferEnglish) label.second else label.first
}

/** Statuses stay in the source's own language regardless of the UI language. */
internal fun localizeYummyStatusFilterLabel(alias: String): String = when (alias.lowercase()) {
    "released" -> "Вышел"
    "ongoing" -> "Онгоинг"
    "announcement" -> "Анонс"
    else -> alias
}

/** Genres stay in the source's own language regardless of the UI language. */
internal fun localizeYummyGenreFilterLabel(alias: String): String =
    genreLabels[alias] ?: formatFallbackFilterLabel(alias, preferEnglish = false)

private fun formatFallbackFilterLabel(alias: String, preferEnglish: Boolean): String {
    if (!preferEnglish) return alias
    return alias
        .replace('-', ' ')
        .replace('_', ' ')
        .split(' ')
        .filter(String::isNotBlank)
        .joinToString(" ") { part -> part.replaceFirstChar { it.uppercase() } }
}

private val genreLabels = mapOf(
    "al-ternativnaya-istoriya" to "Альтернативная история",
    "al-ternativnaya-real-nost" to "Альтернативная реальность",
    "angely" to "Ангелы",
    "androidy" to "Андроиды",
    "antivojna" to "Антивойна",
    "antiutopiya" to "Антиутопия",
    "basketbol" to "Баскетбол",
    "bezumie" to "Безумие",
    "bisenen" to "Бисёнэн",
    "boevye-iskusstva" to "Боевые искусства",
    "bogi" to "Божества",
    "vampiry" to "Вампиры",
    "ved-my" to "Ведьмы",
    "vestern" to "Вестерн",
    "virtual-naya-real-nost" to "Виртуальная реальность",
    "voennaya-tematika" to "Военная тематика",
    "vojna" to "Война",
    "vori" to "Воры",
    "garem" to "Гарем",
    "garem-dlya-devochek" to "Гарем для девочек",
    "trap" to "Гендерная интрига",
    "demony" to "Демоны",
    "detektiv" to "Детектив",
    "dzesej" to "Дзёсэй",
    "drakony" to "Драконы",
    "drama" to "Драма",
    "zombi" to "Зомби",
    "igry" to "Игры",
    "inoplanetyane" to "Инопланетные расы",
    "ii" to "Искусственный интеллект",
    "iskusstvo" to "Искусство",
    "istoricheskij" to "Исторический",
    "isekai" to "Исэкай",
    "kiberpank" to "Киберпанк",
    "kiborgi" to "Киборги",
    "chinese3d" to "Китайское 3D",
    "komediya" to "Комедия",
    "kosmicheskie-priklyucheniya" to "Космос",
    "kulinariya" to "Кулинария",
    "lolikon" to "Лоликон",
    "lyubovnyj-treugol-nik" to "Любовный треугольник",
    "magiya" to "Магия",
    "manga" to "Манга",
    "mafiya-yakudza" to "Мафия/Якудза",
    "maho-sedze" to "Махо-сёдзё",
    "meha" to "Меха",
    "mistika" to "Мистика",
    "motorcycles" to "Мотоциклы",
    "muzyka" to "Музыка",
    "nelinejnyj-syuzhet" to "Нелинейный сюжет",
    "ne-yaponskoe" to "Не японское",
    "nindzya" to "Ниндзя",
    "ohotniki-za-golovami" to "Охотники за головами",
    "parallel-nyj-mir" to "Параллельный мир",
    "parodiya" to "Пародия",
    "perestrelki" to "Перестрелки",
    "pilotiruemye-roboty" to "Пилотируемые роботы",
    "piraty" to "Пираты",
    "povsednevnost" to "Повседневность",
    "politika" to "Политика",
    "policejskie" to "Полицейские",
    "lyudi-zveri" to "Полулюди",
    "postapokaliptika" to "Постапокалиптика",
    "prestupnyj-mir" to "Преступный мир",
    "prizraki" to "Призраки",
    "priklyucheniya" to "Приключения",
    "proksi-boi" to "Прокси бои",
    "psihologiya" to "Психология",
    "puteshestviya-vo-vremeni" to "Путешествия во времени",
    "romantika" to "Романтика",
    "rysalki" to "Русалки",
    "rossiya-v-anime" to "Русские в аниме",
    "samurai" to "Самураи",
    "sverh-estestvennoe" to "Сверхъестественное",
    "sedze" to "Сёдзё",
    "sedze-aj" to "Сёдзё-ай",
    "senen" to "Сёнэн",
    "senen-aj" to "Сёнэн-ай",
    "silovye-kostyumy" to "Силовые костюмы",
    "sovremennoe-fentezi" to "Современное фэнтези",
    "sport" to "Спорт",
    "srazheniya-na-mechah" to "Сражения на мечах",
    "stimpank" to "Стимпанк",
    "sukkuby" to "Суккубы",
    "supersposobnosti" to "Суперспособности",
    "sejnen" to "Сэйнэн",
    "tajnyj-zagovor" to "Тайный заговор",
    "temnoe-fentezi" to "Тёмное фэнтези",
    "temnye-el-fy" to "Тёмные эльфы",
    "terroristy" to "Террористы",
    "transformery" to "Трансформеры",
    "triller" to "Триллер",
    "ubijcy" to "Убийцы",
    "ugasy" to "Ужасы",
    "fantastika" to "Фантастика",
    "fei" to "Феи",
    "fentezi" to "Фэнтези",
    "badguys" to "Хулиганы",
    "celyj-fentezi-mir" to "Целый фэнтези мир",
    "shkola" to "Школьная жизнь",
    "ekshen" to "Экшен",
    "el-fy" to "Эльфы",
    "erotica" to "Эротика",
    "etti" to "Этти",
)
