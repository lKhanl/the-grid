package demo.bank;

import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AccountController {
    private static final Logger log = LoggerFactory.getLogger(AccountController.class);

    @GetMapping("/accounts/{id}")
    public Map<String, Object> account(@PathVariable String id) {
        log.info("GET /accounts/{}", id);
        return Map.of("id", id, "owner", "Şükrü Öztürk", "balance", 1250.75, "currency", "TRY");
    }
}
